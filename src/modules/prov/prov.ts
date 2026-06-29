import type { ProvDocument } from "@inflexa-ai/tsprov";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvActor } from "../../types/prov.ts";
import { Bus } from "../../lib/bus.ts";
import { bakedEnv } from "../../lib/env.ts";
import { getLogger } from "../../lib/log.ts";
import { findAnalysesByRef, getAnalysisIntegrity } from "../../db/primary_query.ts";
import { updateAnalysisProvenance } from "../../db/primary_mutation.ts";
import { appendCreation, appendInputAdded, appendInputRemoved, loadDocument } from "./document.ts";
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
let flushScheduled = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let subscribed = false;

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

function onEvent(event: StampedEvent): void {
    switch (event.type) {
        case "prov.analysis_created": {
            const doc = liveDocForAnalysis(event.analysisId);
            if (!doc) return;
            appendCreation(doc, event.analysisId, event.actor);
            dirty.add(event.analysisId);
            scheduleFlush();
            break;
        }
        case "prov.input_added": {
            const doc = liveDocForAnalysis(event.analysisId);
            if (!doc) return;
            appendInputAdded(doc, event.analysisId, event.actor, event.input, event.derivedFromAnalysisId);
            dirty.add(event.analysisId);
            scheduleFlush();
            break;
        }
        case "prov.input_removed": {
            const doc = liveDocForAnalysis(event.analysisId);
            if (!doc) return;
            appendInputRemoved(doc, event.analysisId, event.actor, event.input);
            dirty.add(event.analysisId);
            scheduleFlush();
            break;
        }
        // Non-prov.* events are ignored.
        default:
            break;
    }
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
    const doc = loadDocument(analysis, integrity?.provenance ?? null);
    liveDocs.set(analysisId, doc);
    // Seed the chain hash from the stored value so the next flush chains correctly.
    if (integrity?.chainHash) chainHashes.set(analysisId, integrity.chainHash);
    return doc;
}

// Coalesce a burst of appends (e.g. create + N inputs) into one async flush. The in-memory document
// is authoritative between flushes; a crash in that window loses the un-flushed tail — the accepted
// trade-off for keeping recording off the synchronous mutation path (the A decision).
function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    flushTimer = setTimeout(() => {
        flushScheduled = false;
        flushTimer = null;
        void flushProvenanceAsync();
    }, 0);
}

/**
 * Async flush: serialize, compute chain hash, sign, then persist all three columns atomically.
 * Every flush is signed — unsigned provenance is never written. A signing failure skips the
 * persist entirely (the dirty set retains the analysis so the next flush retries). Shutdown
 * registers this via {@link onShutdown} so un-flushed provenance is signed and persisted before
 * `process.exit()`. Dirty analyses are flushed concurrently via a {@link WaitGroup} — each
 * analysis signs independently (the keypair is process-cached, so there is no lock contention),
 * and `allSettled` ensures one failure doesn't block the others.
 */
export async function flushProvenanceAsync(): Promise<void> {
    const wg = new WaitGroup();
    wg.goMany([...dirty], async (analysisId) => {
        const doc = liveDocs.get(analysisId);
        if (!doc) {
            dirty.delete(analysisId);
            return;
        }
        const json = doc.unified().serialize("json");

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
                dirty.delete(analysisId);
                chainHashes.set(analysisId, chainHash);
            },
            (e) => log.error({ analysisId, err: e.type }, "failed to persist provenance"),
        );
    });

    await wg.wait();
}

/** Test-only: drop all in-memory live documents, chain hashes, and pending flushes so a fresh DB starts from a clean recorder. */
export function resetProvenanceRecorderForTests(): void {
    liveDocs.clear();
    chainHashes.clear();
    dirty.clear();
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    flushScheduled = false;
}
