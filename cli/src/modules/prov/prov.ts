import { ok, err, type Result } from "neverthrow";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import type { BusEvent, StampedEvent } from "../../types/events.ts";
import type { ProvActor } from "../../types/prov.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { Bus } from "../../lib/bus.ts";
import { bakedEnv } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";
import { dieOn, fail } from "../../lib/cli.ts";
import { findAnalysesByRef, findAnalysesByRefWithAnchor, getAnalysisIntegrity } from "../../db/primary_query.ts";
import { updateAnalysisProvenance } from "../../db/primary_mutation.ts";
import {
    appendCreation,
    appendInputAdded,
    appendInputRemoved,
    appendRunStarted,
    appendRunCompleted,
    appendStepCompleted,
    appendCommandExecuted,
    appendFileWritten,
    appendInputUsed,
    freshDocument,
    loadDocument,
    PROV_UNIFY_OPTIONS,
} from "./document.ts";
import { loadOrGenerateKeypair, computeChainHash, signHexDigest } from "./signing.ts";
import { loadAuth } from "../auth/auth.ts";
import { decodeIdTokenClaims } from "../auth/whoami.ts";
import pkg from "../../../package.json";
import { WaitGroup } from "@/lib/wg.ts";

// The provenance recorder: a process-global bus subscriber that keeps each open analysis's PROV
// document in memory (append-only) and persists it to `analyses.provenance`. Recording is decoupled
// from the analysis mutations that drive it — they emit typed `prov.*` events and forget; this listens.

// --- Actors ---

/**
 * The agent responsible for a user-initiated action: the logged-in user's email, or an anonymous
 * person when unauthenticated. Absence rides the ok channel — a failed/empty auth means anonymous,
 * never an error (the action still happened and must be recorded).
 */
export function currentUserActor(): ProvActor {
    return loadAuth()
        .map((auth) => decodeIdTokenClaims(auth.idToken)?.email)
        .match<ProvActor>(
            (email) => (email ? { kind: "user", email } : { kind: "anonymous" }),
            () => ({ kind: "anonymous" }),
        );
}

/** The agent for a change inflexa makes autonomously: the CLI itself, stamped with its version and source commit. */
export function systemActor(): ProvActor {
    return { kind: "system", version: pkg.version, commit: bakedEnv.gitCommit };
}

// --- Recorder ---

const log = getLogger("prov");

// One live document per analysis touched this process. The analysis lock means a process drives a
// single analysis interactively, but keying by id keeps the recorder correct without relying on that.
const liveDocs = new Map<string, ProvDocument>();
// Last known chain hash per analysis — loaded from the DB on first touch, updated after each signed
// flush so subsequent flushes chain correctly without a re-read.
const chainHashes = new Map<string, string | null>();
// Analyses whose live doc has appends not yet written to the column, awaiting the next flush.
const dirty = new Set<string>();
// Per-analysis append revision, bumped on EVERY append (via `markDirty`). A flush records the
// revision of the bytes it serialized and clears `dirty` only if that revision still holds when the
// (async) sign+persist returns. An append that lands mid-flush advances the revision, so the flush
// that snapshotted the earlier bytes leaves the analysis dirty and the drain re-serializes the tail.
// Without this guard the trailing `dirty.delete` would swallow an append that arrived during the
// flush's await window — e.g. a run's terminal `run_completed`, then lost to the DB once the process
// exits (the shutdown drain also reads `dirty`).
const revision = new Map<string, number>();
// Flush is single-flight process-wide. `flushInProgress` gates re-entry so two passes never overlap
// and thus never read the same `prev` chain hash and fork the chain; `flushRequested` records wakeups
// that arrive during a pass so the drain loop consumes them without losing one; `pending` is the
// in-flight pass the shutdown drain awaits.
let flushInProgress = false;
let flushRequested = false;
let pending: Promise<void> = Promise.resolve();
let flushScheduled = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;

/** Record an append against `analysisId`: advance its revision, mark it dirty, and wake the flush. */
function markDirty(analysisId: string): void {
    revision.set(analysisId, (revision.get(analysisId) ?? 0) + 1);
    dirty.add(analysisId);
    scheduleFlush();
}

/**
 * Subscribe the recorder to the bus. Explicit init (not an import side effect), mirroring
 * `initBusLogging` — importing this module never starts recording. Must run before any analysis
 * mutation can emit (so it is wired at CLI startup, alongside `initBusLogging`). Idempotent.
 */
export function initProvenanceRecording(): void {
    if (subscribed) return;
    subscribed = true;
    Bus.on("inflexa", onEvent);
}

/** The `prov.*` subset of {@link StampedEvent} — the events the recorder records. Every one carries `analysisId`; the session-scoped events it ignores carry `sessionId` instead. */
type StampedProvEvent = Extract<BusEvent, { type: `prov.${string}` }> & { __infId: string };

/**
 * Narrow a bus event to the `prov.*` subset. The `prov.` prefix IS the discriminant, so
 * `startsWith("prov.")` corresponds exactly to the `prov.${string}` template type — that equivalence
 * is what makes this type predicate sound. Narrowing up front lets the live-doc lookup and the
 * dirty-mark — identical across every prov event — hoist out of the switch below, and is the sole
 * reason `event.analysisId` is reachable before it (a session-scoped event has no `analysisId`).
 */
function isProvEvent(event: StampedEvent): event is StampedProvEvent {
    return event.type.startsWith("prov.");
}

function onEvent(event: StampedEvent): void {
    // Session-scoped events are not ours — drop them before the shared work. The switch then dispatches
    // ONLY the per-event builder; the doc lookup, its guard, and the dirty-mark are common to all of it.
    if (!isProvEvent(event)) return;
    const doc = liveDocForAnalysis(event.analysisId);
    if (!doc) return;

    // A builder throw MUST NOT unwind into the emitter. Bus is a raw EventEmitter that runs listeners
    // un-isolated, and several prov emit sites are UNGUARDED — notably the ArtifactRegistry `register()`
    // path (`prov_bridge.ts`), whose harness caller treats a throw as an attestation failure and fails
    // the step, orphaning its outputs. So a defect in one builder must drop that single record (log +
    // skip the dirty-mark), never crash the emitting mutation/step. The builders don't call `unified()`
    // today, so this is defense-in-depth against a future append-time invariant, not a live path.
    try {
        switch (event.type) {
            case "prov.analysis_created":
                appendCreation(doc, event.analysisId, event.actor);
                break;
            case "prov.input_added":
                appendInputAdded(doc, event.analysisId, event.actor, event.input, event.derivedFromAnalysisId);
                break;
            case "prov.input_removed":
                appendInputRemoved(doc, event.analysisId, event.actor, event.input);
                break;
            case "prov.run_started":
                appendRunStarted(doc, event.analysisId, event.actor, event.run);
                break;
            case "prov.run_completed":
                appendRunCompleted(doc, event.analysisId, event.actor, event.outcome);
                break;
            case "prov.step_completed":
                appendStepCompleted(doc, event.analysisId, event.actor, event.outcome, event.model);
                break;
            case "prov.command_executed":
                appendCommandExecuted(doc, event.analysisId, event.actor, event.step, event.command, event.model);
                break;
            case "prov.file_written":
                appendFileWritten(doc, event.analysisId, event.actor, event.file, event.step, event.generation);
                break;
            case "prov.input_used":
                appendInputUsed(doc, event.analysisId, event.actor, event.step, event.input);
                break;
            default:
                // `event satisfies never`: every prov.* variant is handled above, so a NEW one added to
                // BusEvent without a case here fails to compile at this line — a forgotten wiring is a
                // build error, not a silently dropped record.
                event satisfies never;
                // `event.type` is statically `never` here but holds the real event's discriminant at
                // runtime, naming which unhandled variant was dropped.
                log.error({ type: (event as StampedEvent).type }, "unhandled prov event — not recorded");
                return;
        }
    } catch (err) {
        log.error({ type: event.type, analysisId: event.analysisId, err }, "prov builder threw; record dropped");
        return;
    }

    markDirty(event.analysisId);
}

/** The analysis's live document — cached, else rebuilt from its stored PROV-JSON, else seeded fresh. `null` only when the analysis row has vanished. */
function liveDocForAnalysis(analysisId: string): ProvDocument | null {
    const cached = liveDocs.get(analysisId);
    if (cached) return cached;

    // First touch this process: the Analysis row supplies the subject entity's name/slug when seeding
    // a fresh document; the integrity columns supply the prior chain hash for chaining subsequent flushes.
    const analysis = findAnalysesByRef(analysisId).match(
        (rows) => rows[0] ?? null,
        (e) => {
            log.error({ analysisId, err: e.type, cause: e.cause }, "failed to look up analysis row");
            return null;
        },
    );
    if (!analysis) {
        log.warn({ analysisId }, "prov event for unknown analysis; skipping");
        return null;
    }
    const integrity = getAnalysisIntegrity(analysisId).match(
        (i) => i,
        (e) => {
            log.warn({ analysisId, err: e.type }, "failed to read integrity columns; starting fresh chain");
            return null;
        },
    );
    const docResult = loadDocument(analysis, integrity?.provenance ?? null);
    if (docResult.isErr()) {
        log.error({ analysisId, cause: docResult.error.cause }, "stored provenance is corrupt; starting fresh document");
        // Clear the stale chain hash so the next flush starts a new chain instead
        // of chaining from the old (now-disconnected) hash.
        chainHashes.delete(analysisId);
        const fresh = freshDocument(analysis);
        liveDocs.set(analysisId, fresh);
        return fresh;
    }
    const doc = docResult.value;
    liveDocs.set(analysisId, doc);
    // Seed the chain hash from the stored value so the next flush chains correctly.
    if (integrity?.chainHash) chainHashes.set(analysisId, integrity.chainHash);
    return doc;
}

// Coalesce a burst of appends (e.g. create + N inputs) into one async flush. The in-memory document
// is authoritative between flushes; a crash in that window loses the un-flushed tail — the accepted
// trade-off for keeping recording off the synchronous mutation path (the A decision).
function scheduleFlush(): void {
    flushRequested = true;
    // A pass already running will drain this wakeup itself (its loop re-reads `dirty` while
    // `flushRequested` is set); a timer already armed will start one. Either way, do NOT arm a second
    // timer — single-flight is enforced in `runFlush`, and a bare re-arm here would let two passes
    // overlap and read the same `prev` chain hash.
    if (flushScheduled || flushInProgress) return;
    flushScheduled = true;
    flushTimer = setTimeout(() => {
        flushScheduled = false;
        flushTimer = null;
        launchFlush();
    }, 0);
}

/** Start a flush pass unless one is already running (which will itself drain the new wakeup). */
function launchFlush(): void {
    if (flushInProgress) return;
    pending = runFlush();
}

/**
 * Drive the flush loop to quiescence and await it. Every flush is SIGNED — unsigned provenance is
 * never written; a signing/persist failure skips only that analysis (its `dirty` flag is retained so
 * a later append retries it) and never degrades to an unsigned column. Shutdown registers this via
 * {@link onShutdown} so un-flushed provenance is signed and persisted before `process.exit()`.
 *
 * Safe to call concurrently and re-enter: {@link runFlush}'s single-flight guard coalesces, so this
 * only ever awaits the one in-flight pass. It returns once `dirty` is empty, or once a pass makes no
 * progress (a persistent signing/persist fault) — looping past that would hang shutdown, and since we
 * refuse to write unsigned bytes there is nothing left to attempt but to surface it.
 */
export async function flushProvenanceAsync(): Promise<void> {
    let previousDirty = Infinity;
    do {
        launchFlush();
        await pending;
        // Stop if a pass cleared nothing (persistent signing/persist failure); a late append that
        // re-dirties shrinks `dirty` on the next pass, so a strictly-not-smaller size means no progress.
        if (dirty.size >= previousDirty) break;
        previousDirty = dirty.size;
    } while (dirty.size > 0);
    if (dirty.size > 0) log.error({ analyses: [...dirty] }, "provenance flush could not drain — signing or persist is failing");
}

/**
 * One single-flight flush loop: drain passes until no wakeup is outstanding. `flushRequested` is
 * consumed at the top of each pass; an append during the pass sets it again (via {@link markDirty}),
 * so the loop runs once more and serializes that append's tail — this is what makes an append landing
 * mid-flush survive rather than being swallowed by a trailing `dirty.delete`. The per-analysis
 * snapshot (revision + bytes) is captured SYNCHRONOUSLY in the loop body — no `await` between reading
 * `dirty` and serializing — so an append can never interleave into a half-built snapshot, and each
 * analysis appears at most once per pass (`dirty` is a Set) so the concurrent {@link persistSnapshot}
 * calls touch disjoint chains. Single-flight (this guard) plus that disjointness is what stops two
 * flushes reading the same `prev` chain hash and forking the chain.
 */
async function runFlush(): Promise<void> {
    if (flushInProgress) return;
    flushInProgress = true;
    try {
        do {
            flushRequested = false;
            const wg = new WaitGroup();
            for (const analysisId of [...dirty]) {
                const doc = liveDocs.get(analysisId);
                if (!doc) {
                    dirty.delete(analysisId);
                    revision.delete(analysisId);
                    continue;
                }
                // Last-write-wins merge ({@link PROV_UNIFY_OPTIONS}, shared with the export path): a
                // re-emitted terminal record (recovery replay → identical; resume → newer) resolves to
                // one survivor rather than throwing, so a conflict can never leave the analysis dirty
                // and permanently unpersistable.
                const snapshotRevision = revision.get(analysisId) ?? 0;
                let json: string;
                try {
                    json = doc.unified(PROV_UNIFY_OPTIONS).serialize("json");
                } catch (err) {
                    // Isolate a serialize/unify fault to its own analysis. This runs SYNCHRONOUSLY in the
                    // pass loop, so an uncaught throw would abort the whole pass (skipping every other
                    // dirty analysis) AND reject `pending` — which, in the timer-driven path (`launchFlush`
                    // sets `pending` with no `.catch`), surfaces as an unhandled rejection that can crash
                    // the process. Leave the doc dirty (as a sign/persist failure does) so a later append
                    // retries it, and press on; a persistently-poisoned doc simply stops making progress,
                    // which `flushProvenanceAsync`'s no-progress guard already tolerates.
                    log.error({ analysisId, err }, "provenance serialize failed; leaving dirty for retry");
                    continue;
                }
                wg.go(persistSnapshot(analysisId, json, snapshotRevision));
            }
            await wg.wait();
        } while (flushRequested);
    } finally {
        flushInProgress = false;
    }
}

/**
 * Sign and persist one already-serialized snapshot. Single-flight (see {@link runFlush}) guarantees no
 * other pass mutates this analysis's chain hash between the `prev` read and the `set` below, so the
 * chain never forks. On any signing/persist failure the analysis stays dirty (retried later) and NO
 * unsigned bytes are written. On success, `dirty` is cleared ONLY when the snapshot revision still
 * holds — an append that landed after the snapshot keeps the analysis dirty for the next pass.
 */
async function persistSnapshot(analysisId: string, json: string, snapshotRevision: number): Promise<void> {
    const kpResult = await loadOrGenerateKeypair();
    if (kpResult.isErr()) {
        log.error({ analysisId, err: kpResult.error.type }, "signing key unavailable; provenance not persisted");
        return;
    }
    const kp = kpResult.value;

    const prev = chainHashes.get(analysisId) ?? null;
    const result = await computeChainHash(prev, json).andThen((chainHash) =>
        signHexDigest(kp.privateKey, chainHash).map((signature) => ({ chainHash, signature })),
    );
    if (result.isErr()) {
        log.error({ analysisId, err: result.error }, "signing failed; provenance not persisted");
        return;
    }
    const { chainHash, signature } = result.value;
    updateAnalysisProvenance(analysisId, json, chainHash, signature).match(
        () => {
            chainHashes.set(analysisId, chainHash);
            // Clear dirty only if no append landed after this snapshot; otherwise the tail (records
            // not in `json`) stays dirty and the drain re-serializes the mutated document.
            if ((revision.get(analysisId) ?? 0) === snapshotRevision) dirty.delete(analysisId);
        },
        (e) => log.error({ analysisId, err: e.type }, "failed to persist provenance"),
    );
}

/** Test-only: drop all in-memory live documents, chain hashes, and pending flushes so a fresh DB starts from a clean recorder. */
export function resetProvenanceRecorderForTests(): void {
    liveDocs.clear();
    chainHashes.clear();
    dirty.clear();
    revision.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    flushScheduled = false;
    flushInProgress = false;
    flushRequested = false;
    pending = Promise.resolve();
}

// --- Analysis resolution for the prov command actions ---

/** Why a prov analysis reference failed to resolve — ambiguity carries what the user needs to re-ask with an exact id. */
export type ProvAnalysisRefError =
    { type: "not_found" } | { type: "ambiguous"; candidates: { id: string; name: string; createdAt: number; anchorPath: string | null }[] };

/**
 * Resolve an id-or-name ref to exactly ONE analysis for the prov actions, via the db resolver's
 * id-first ordering. An exact-id hit is THE match (ids are unique) even when other analyses share
 * the ref as a name; a lone row resolves; several rows with no id hit is a genuine name/slug
 * collision and fails with the candidates — a prov command must never silently pick the newest of
 * same-named analyses, or every downstream claim (lineage, export, verification) is quietly about
 * the wrong document. Each candidate carries its anchor folder's last-known path, the fact a user
 * actually recognizes when names collide; it is `null` when the anchor row is gone (a normal
 * local-state desync, never an error). Storage faults stay on the `DbError` channel.
 */
export function resolveAnalysisForProv(ref: IdOrName): Result<Analysis, DbError | ProvAnalysisRefError> {
    return findAnalysesByRefWithAnchor(ref).andThen((rows): Result<Analysis, DbError | ProvAnalysisRefError> => {
        const [first] = rows;
        if (first === undefined) return err({ type: "not_found" });
        // The query sorts an exact-id hit first, so inspecting the head row suffices.
        if (first.analysis.id === ref || rows.length === 1) return ok(first.analysis);
        return err({
            type: "ambiguous",
            candidates: rows.map((r) => ({ id: r.analysis.id, name: r.analysis.name, createdAt: r.analysis.createdAt, anchorPath: r.anchorPath })),
        });
    });
}

/**
 * The CLI-boundary wrapper every analysis-ref prov action shares: resolve the analysis or exit.
 * Ambiguity lists each candidate's id, name, local creation time (the same `toLocaleString()`
 * formatting the analyses listing shows, so the two listings read identically), and last-known
 * anchor folder, so the user recognizes the one they mean and re-runs with its exact id — prov
 * commands are headless-first, so the failure must be deterministic, never a prompt. Lives beside
 * the resolver so the three actions cannot drift on the failure wording.
 */
export function requireAnalysisForProv(ref: IdOrName): Analysis {
    return resolveAnalysisForProv(ref).match(
        (a) => a,
        (e) => {
            if (e.type === "not_found") fail(`No analysis found matching "${ref}".`);
            if (e.type === "ambiguous") {
                const list = e.candidates
                    // "(folder unknown)" reads as a fact about the local state, not a failure: the
                    // anchor row is gone, so the folder's whereabouts are simply not known anymore.
                    .map((c) => `  ${c.id}  ${c.name}  ${new Date(c.createdAt).toLocaleString()}  ${c.anchorPath ?? "(folder unknown)"}`)
                    .join("\n");
                fail(`Analysis reference "${ref}" is ambiguous — re-run with an exact id:\n${list}`);
            }
            return dieOn("Failed to resolve analysis")(e);
        },
    );
}
