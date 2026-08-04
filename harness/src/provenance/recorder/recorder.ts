import type { ResultAsync } from "neverthrow";
import type { ProvDocument } from "@inflexa-ai/tsprov";
import type { Logger } from "../../lib/logger.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { ProvEvent, ProvSubject } from "./types.js";
import { createProvDocumentModel, PROV_UNIFY_OPTIONS, type ProvDocumentModel } from "./document.js";
import type { ProvSigner } from "./signing.js";
import { computeChainHash } from "./signing.js";

/**
 * The provenance recorder: keeps each touched analysis's PROV document in memory (append-only)
 * and persists it — whole, signed, and chain-hashed — through the injected {@link ProvSnapshotSink}.
 * Recording is decoupled from the execution paths that drive it: they call {@link ProvenanceRecorder.record}
 * and forget (directly, or through whatever transport the host already runs); this folds and flushes.
 *
 * SINGLE WRITER PER ANALYSIS: the embedder guarantees at most one live recorder appends to an
 * analysis's document at a time (an analysis lock, durable-workflow ownership, or equivalent). A
 * sink that supports compare-and-swap on `prevChainHash` detects a violation as a `conflict`
 * persist error; the recorder then refreshes its chain head and re-persists — the chain never
 * forks — but content-level reconciliation of concurrent writers is out of scope.
 */

/** What a sink returns on first touch: the subject to seed a fresh document from, plus the stored form when one exists. */
export type ProvSnapshotSeed = {
    subject: ProvSubject;
    provJson: string | null;
    chainHash: string | null;
};

/** One signed snapshot to persist — the whole serialized document plus its chain values. */
export type ProvSnapshot = {
    analysisId: string;
    provJson: string;
    chainHash: string;
    prevChainHash: string | null;
    signature: string;
};

export type ProvSinkError =
    | { type: "load_failed"; cause?: unknown }
    | { type: "persist_failed"; cause?: unknown }
    /** The sink's compare-and-swap on `prevChainHash` rejected a stale write — another writer advanced the chain. */
    | { type: "conflict" };

/**
 * The snapshot persistence seam a host fills at its composition root: the OSS host reads/writes
 * SQLite columns; a managed host GETs/PUTs its backend's document endpoint. `load` resolves `null`
 * for an analysis the host does not know — the recorder drops that analysis's events.
 */
export interface ProvSnapshotSink {
    load(analysisId: string): ResultAsync<ProvSnapshotSeed | null, ProvSinkError>;
    persist(snapshot: ProvSnapshot): ResultAsync<void, ProvSinkError>;
}

export interface ProvenanceRecorderDeps {
    readonly sink: ProvSnapshotSink;
    readonly signer: ProvSigner;
    /** The QName/document derivations to append with. Defaults to `createProvDocumentModel()`. */
    readonly documentModel?: ProvDocumentModel;
    readonly logger?: Logger;
}

export interface ProvenanceRecorder {
    /**
     * Record one event, fire-and-forget: never throws, never blocks the caller. The first event
     * for an analysis starts the sink load and queues; a builder failure drops that single record.
     */
    record(event: ProvEvent): void;
    /**
     * Drive the flush loop to quiescence and await it — the shutdown/terminal drain. Returns once
     * nothing is dirty, or once a pass makes no progress (a persistent signing/persist fault);
     * looping past that would hang shutdown, and unsigned bytes are never an alternative.
     */
    flush(): Promise<void>;
}

/** Per-analysis lifecycle: sink load in flight (events queue), ready (events append), or skipped (unknown analysis). */
type DocEntry = { state: "loading"; queue: ProvEvent[]; settled: Promise<void> } | { state: "ready"; doc: ProvDocument } | { state: "skipped" };

export function createProvenanceRecorder(deps: ProvenanceRecorderDeps): ProvenanceRecorder {
    const log = (deps.logger ?? createNoopLogger()).named("provenance.recorder");
    const model = deps.documentModel ?? createProvDocumentModel();

    // One live entry per analysis touched by this instance. All state is per-instance — tests
    // construct fresh recorders instead of resetting globals.
    const entries = new Map<string, DocEntry>();
    // Last known chain hash per analysis — seeded from the sink on first touch, updated after each
    // signed flush so subsequent flushes chain correctly without a re-read. Cleared on a persist
    // `conflict` so the next flush re-reads the advanced head.
    const chainHashes = new Map<string, string | null>();
    // Analyses whose live doc has appends not yet persisted, awaiting the next flush.
    const dirty = new Set<string>();
    // Per-analysis append revision, bumped on EVERY append. A flush records the revision of the
    // bytes it serialized and clears `dirty` only if that revision still holds when the (async)
    // sign+persist returns — an append that lands mid-flush advances the revision, so the flush
    // that snapshotted the earlier bytes leaves the analysis dirty and the drain re-serializes the
    // tail.
    const revision = new Map<string, number>();
    // Analyses whose chain head must be refreshed from the sink before the next persist (a CAS
    // `conflict` was observed).
    const staleChains = new Set<string>();

    // Flush is single-flight per instance. `flushInProgress` gates re-entry so two passes never
    // overlap and thus never read the same `prev` chain hash and fork the chain; `flushRequested`
    // records wakeups that arrive during a pass so the drain loop consumes them without losing
    // one; `pending` is the in-flight pass the drain awaits.
    let flushInProgress = false;
    let flushRequested = false;
    let pending: Promise<void> = Promise.resolve();
    let flushScheduled = false;

    /** Record an append against `analysisId`: advance its revision, mark it dirty, and wake the flush. */
    function markDirty(analysisId: string): void {
        revision.set(analysisId, (revision.get(analysisId) ?? 0) + 1);
        dirty.add(analysisId);
        scheduleFlush();
    }

    /** Append one event into a ready document. A builder throw MUST NOT unwind into the caller — a defect in one builder drops that single record, never the emitting execution path. */
    function appendEvent(doc: ProvDocument, event: ProvEvent): boolean {
        try {
            switch (event.type) {
                case "analysis_created":
                    model.appendCreation(doc, event.analysisId, event.actor);
                    break;
                case "input_added":
                    model.appendInputAdded(doc, event.analysisId, event.actor, event.input, event.derivedFromAnalysisId);
                    break;
                case "input_removed":
                    model.appendInputRemoved(doc, event.analysisId, event.actor, event.input);
                    break;
                case "run_started":
                    model.appendRunStarted(doc, event.analysisId, event.actor, event.run);
                    break;
                case "run_completed":
                    model.appendRunCompleted(doc, event.analysisId, event.actor, event.outcome);
                    break;
                case "step_completed":
                    model.appendStepCompleted(doc, event.analysisId, event.actor, event.outcome, event.model);
                    break;
                case "command_executed":
                    model.appendCommandExecuted(doc, event.analysisId, event.actor, event.step, event.command, event.model);
                    break;
                case "file_written":
                    model.appendFileWritten(doc, event.analysisId, event.actor, event.file, event.step, event.generation);
                    break;
                case "input_used":
                    model.appendInputUsed(doc, event.analysisId, event.actor, event.step, event.input);
                    break;
                default: {
                    event satisfies never;
                    log.error("unhandled prov event — not recorded", { type: (event as ProvEvent).type });
                    return false;
                }
            }
            return true;
        } catch (cause) {
            log.error("prov builder threw; record dropped", { type: event.type, analysisId: event.analysisId, cause });
            return false;
        }
    }

    /** Resolve the first-touch sink load: seed or rebuild the document, adopt the chain head, drain the queue. */
    function settleLoad(analysisId: string, queueRef: { queue: ProvEvent[] }): Promise<void> {
        return deps.sink.load(analysisId).match(
            (seed) => {
                if (seed === null) {
                    log.warn("prov event for unknown analysis; skipping", { analysisId });
                    entries.set(analysisId, { state: "skipped" });
                    return;
                }
                const docResult = model.loadDocument(seed.subject, seed.provJson);
                let doc: ProvDocument;
                if (docResult.isErr()) {
                    log.error("stored provenance is corrupt; starting fresh document", { analysisId, cause: docResult.error.cause });
                    // Clear the stale chain hash so the next flush starts a new chain instead of
                    // chaining from the old (now-disconnected) hash.
                    chainHashes.delete(analysisId);
                    doc = model.freshDocument(seed.subject);
                } else {
                    doc = docResult.value;
                    if (seed.chainHash) chainHashes.set(analysisId, seed.chainHash);
                }
                entries.set(analysisId, { state: "ready", doc });
                for (const event of queueRef.queue) {
                    if (appendEvent(doc, event)) markDirty(analysisId);
                }
            },
            (e) => {
                // Transient load failure: drop this batch, but forget the entry so a later event
                // retries the load rather than an analysis staying dark for the process lifetime.
                log.error("failed to load provenance snapshot; events dropped", { analysisId, error: e.type, cause: "cause" in e ? e.cause : undefined });
                entries.delete(analysisId);
            },
        );
    }

    function record(event: ProvEvent): void {
        const entry = entries.get(event.analysisId);
        if (entry === undefined) {
            const queueRef = { queue: [event] };
            const fresh: DocEntry = { state: "loading", queue: queueRef.queue, settled: settleLoad(event.analysisId, queueRef) };
            entries.set(event.analysisId, fresh);
            return;
        }
        switch (entry.state) {
            case "loading":
                entry.queue.push(event);
                return;
            case "ready":
                if (appendEvent(entry.doc, event)) markDirty(event.analysisId);
                return;
            case "skipped":
                return;
        }
    }

    // Coalesce a burst of appends into one async flush. The in-memory document is authoritative
    // between flushes; a crash in that window loses the un-flushed tail — the accepted trade-off
    // for keeping recording off the synchronous execution path.
    function scheduleFlush(): void {
        flushRequested = true;
        // A pass already running will drain this wakeup itself (its loop re-reads `dirty` while
        // `flushRequested` is set); a timer already armed will start one. Either way, do NOT arm a
        // second timer — single-flight is enforced in `runFlush`, and a bare re-arm would let two
        // passes overlap and read the same `prev` chain hash.
        if (flushScheduled || flushInProgress) return;
        flushScheduled = true;
        setTimeout(() => {
            flushScheduled = false;
            launchFlush();
        }, 0);
    }

    /** Start a flush pass unless one is already running (which will itself drain the new wakeup). */
    function launchFlush(): void {
        if (flushInProgress) return;
        pending = runFlush();
    }

    /**
     * One single-flight flush loop: drain passes until no wakeup is outstanding. The per-analysis
     * snapshot (revision + bytes) is captured SYNCHRONOUSLY in the loop body — no `await` between
     * reading `dirty` and serializing — so an append can never interleave into a half-built
     * snapshot, and each analysis appears at most once per pass so the concurrent
     * {@link persistSnapshot} calls touch disjoint chains.
     */
    async function runFlush(): Promise<void> {
        if (flushInProgress) return;
        flushInProgress = true;
        try {
            do {
                flushRequested = false;
                const inFlight: Promise<void>[] = [];
                for (const analysisId of [...dirty]) {
                    const entry = entries.get(analysisId);
                    if (entry === undefined || entry.state !== "ready") {
                        dirty.delete(analysisId);
                        revision.delete(analysisId);
                        continue;
                    }
                    // Last-write-wins merge ({@link PROV_UNIFY_OPTIONS}): a re-emitted terminal
                    // record (recovery replay → identical; resume → newer) resolves to one survivor
                    // rather than throwing, so a conflict can never leave the analysis permanently
                    // unpersistable.
                    const snapshotRevision = revision.get(analysisId) ?? 0;
                    let json: string;
                    try {
                        json = entry.doc.unified(PROV_UNIFY_OPTIONS).serialize("json");
                    } catch (cause) {
                        // Isolate a serialize/unify fault to its own analysis: an uncaught throw
                        // here would abort the whole pass AND reject `pending` as an unhandled
                        // rejection. Leave the doc dirty so a later append retries it; a
                        // persistently-poisoned doc stops making progress, which `flush()`'s
                        // no-progress guard tolerates.
                        log.error("provenance serialize failed; leaving dirty for retry", { analysisId, cause });
                        continue;
                    }
                    inFlight.push(persistSnapshot(analysisId, json, snapshotRevision));
                }
                await Promise.all(inFlight);
            } while (flushRequested);
        } finally {
            flushInProgress = false;
        }
    }

    /**
     * Sign and persist one already-serialized snapshot. Single-flight (see {@link runFlush})
     * guarantees no other pass mutates this analysis's chain hash between the `prev` read and the
     * `set` below, so the chain never forks. On any signing/persist failure the analysis stays
     * dirty (retried later) and NO unsigned bytes are written. On success, `dirty` is cleared ONLY
     * when the snapshot revision still holds.
     */
    async function persistSnapshot(analysisId: string, json: string, snapshotRevision: number): Promise<void> {
        // A prior persist saw a CAS conflict: another writer advanced the chain, so re-read the
        // head before chaining onto it. Content is still this instance's document — single-writer
        // is the embedder's guarantee; this keeps the CHAIN honest when it is violated.
        if (staleChains.has(analysisId)) {
            const refreshed = await deps.sink.load(analysisId).match(
                (seed) => ({ ok: true as const, chainHash: seed?.chainHash ?? null }),
                (e) => {
                    log.error("failed to refresh chain head after conflict", { analysisId, error: e.type });
                    return { ok: false as const, chainHash: null };
                },
            );
            if (!refreshed.ok) return;
            chainHashes.set(analysisId, refreshed.chainHash);
            staleChains.delete(analysisId);
        }

        const prev = chainHashes.get(analysisId) ?? null;
        const result = await computeChainHash(prev, json).andThen((chainHash) => deps.signer.sign(chainHash).map((signature) => ({ chainHash, signature })));
        if (result.isErr()) {
            log.error("signing failed; provenance not persisted", { analysisId, error: result.error.type });
            return;
        }
        const { chainHash, signature } = result.value;
        await deps.sink.persist({ analysisId, provJson: json, chainHash, prevChainHash: prev, signature }).match(
            () => {
                chainHashes.set(analysisId, chainHash);
                // Clear dirty only if no append landed after this snapshot; otherwise the tail
                // stays dirty and the drain re-serializes the mutated document.
                if ((revision.get(analysisId) ?? 0) === snapshotRevision) dirty.delete(analysisId);
            },
            (e) => {
                if (e.type === "conflict") {
                    staleChains.add(analysisId);
                    log.error("persist rejected as stale (chain advanced by another writer); will re-chain", { analysisId });
                    return;
                }
                log.error("failed to persist provenance", { analysisId, error: e.type, cause: "cause" in e ? e.cause : undefined });
            },
        );
    }

    async function flush(): Promise<void> {
        let previousDirty = Infinity;
        do {
            // A first-touch load still in flight holds queued events that are not yet dirty; drain
            // it first so a terminal flush never returns with those events unpersisted.
            const loading = [...entries.values()].filter((e) => e.state === "loading").map((e) => e.settled);
            if (loading.length > 0) await Promise.all(loading);
            launchFlush();
            await pending;
            // Stop if a pass cleared nothing (persistent signing/persist failure); a late append
            // that re-dirties shrinks `dirty` on the next pass, so a strictly-not-smaller size
            // means no progress.
            if (dirty.size >= previousDirty) break;
            previousDirty = dirty.size;
        } while (dirty.size > 0);
        if (dirty.size > 0) log.error("provenance flush could not drain — signing or persist is failing", { analyses: [...dirty] });
    }

    return { record, flush };
}
