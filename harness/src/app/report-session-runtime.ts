/**
 * The report session-state runtime -- the durable realization of the session-state
 * gateway, and the idempotent operation that anchors one report session.
 *
 * The runtime binds three parts: the session-state store, the thread store, and
 * the pin. The tool layer speaks the gateway, and the gateway speaks a plain
 * discriminated value. Thus the neverthrow of the store stays inside this module,
 * and it never crosses the tool boundary.
 *
 * `ensureSessionState` makes sure that the row of a thread exists. The first run
 * resolves the analysis of the thread, pins the snapshot, and writes the row. A
 * later run reads the row and pins nothing. The store insert-if-absent keeps two
 * concurrent first runs to one row. A pin failure writes no row and returns as
 * typed data, thus a later run pins again.
 *
 * The gateway `load` runs the same operation, thus a tool call never arrives
 * before the state exists. A fresh row holds the snapshot and no document yet.
 * Thus `load` gives the empty draft with the stored snapshot, because the pin
 * writes the snapshot first and the document lands later.
 *
 * A store fault, an absent thread, and a pin failure each ride the failed arm
 * with a short detail. The diagnostic goes to the injected `Logger`, never to the
 * detail alone.
 *
 * The gateway load separates a permanent condition from a transient one. An absent
 * thread and a wrong thread type are permanent, and a store or pin fault is
 * transient. The persist is a compare-and-swap against the prior document that the
 * load read, thus two concurrent turns cannot both land.
 *
 * The load serves the stored pin with the derivations of the session merged onto it.
 * Thus a derived table binds, resolves, and validates the same way as a pinned one.
 * The stored pin never changes, thus the anchor stays honest and the merge is
 * recomputable from the row.
 */

import type { Pool } from "pg";

import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { createThreadStore } from "../memory/thread-store.js";
import type { DraftDocument } from "../report-model/draft.js";
import { pinReportSnapshot } from "../report-model/pin-snapshot.js";
import type { ArtifactSnapshot, ReportSnapshot } from "../report-model/reference-resolver.js";
import {
    createReportSessionStateStore,
    type DerivationRecord,
    type ReportSessionState as StoredSessionState,
    type ReportSessionStateStore,
    type SessionStateReadError,
} from "../state/report-session-state.js";
import type {
    ReportSessionStateGateway,
    SeenStampResult,
    SessionStateLoad,
    SessionStatePersist,
    SessionStateToken,
    StampResult,
} from "../tools/report-authoring/authoring-tools.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";

/** The empty draft of a fresh session. The pin writes the snapshot first, thus the document is empty here. */
const EMPTY_DRAFT: DraftDocument = { title: "", sections: [] };

/**
 * How a failed anchor ends. `absent-thread` and `wrong-thread-type` are permanent
 * conditions, and `unavailable` is a transient store or pin fault. The gateway load
 * carries the distinction, thus the tool tells a permanent refusal from a transient one.
 */
export type EnsureFailureKind = "absent-thread" | "wrong-thread-type" | "unavailable";

/**
 * The outcome of the anchor operation. `ready` carries the durable row, whose
 * document is `null` until the first document lands. `failed` names the cause as a
 * short detail and a kind, and the runtime logs the diagnostic beside it.
 */
export type EnsureSessionStateResult = { outcome: "ready"; state: StoredSessionState } | { outcome: "failed"; kind: EnsureFailureKind; detail: string };

export interface ReportSessionRuntimeDeps {
    readonly pool: Pool;
    /**
     * The workspace-root seam of the pin. The citation evidence of an analysis sits on disk under the
     * root, thus a composition that binds no seam pins the artifact map alone.
     */
    readonly resolveWorkspaceRoot?: ResolveWorkspaceRoot;
    readonly logger?: Logger;
}

/**
 * The report session-state runtime. The gateway serves the authoring tools, and
 * `ensureSessionState` anchors the session. The spawn of a report session runs
 * `ensureSessionState` at the moment of the spawn, the serving path of a report
 * turn runs it at the turn start, and the gateway `load` runs it too. Thus a tool
 * call cannot arrive before the state exists.
 */
export interface ReportSessionRuntime {
    readonly gateway: ReportSessionStateGateway;
    /**
     * The derivation ledger of the session state. The derivation tool appends one record for each
     * derivation, and the gateway load serves each record as a member of the snapshot.
     */
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    ensureSessionState(threadId: string): Promise<EnsureSessionStateResult>;
}

/**
 * The served membership: the stored pin, with one entry for each derivation of the session.
 *
 * The tools read the served snapshot, thus a derived table binds the same way as a pinned one. The stored
 * pin stays untouched, thus the merge runs again on each load and the row keeps the evidence of the pin
 * alone.
 *
 * A derived entry carries the output hash alone. A file type states a role of the run ledger, and a
 * derivation holds none. The map takes a null prototype, the same as the stored parse, thus a path such as
 * `__proto__` stays an ordinary entry.
 */
function serveMembership(snapshot: ReportSnapshot, derivations: readonly DerivationRecord[]): ReportSnapshot {
    if (derivations.length === 0) {
        return snapshot;
    }
    const artifacts: Record<string, ArtifactSnapshot> = Object.create(null);
    for (const [path, entry] of Object.entries(snapshot.artifacts)) {
        artifacts[path] = entry;
    }
    for (const record of derivations) {
        artifacts[record.outputPath] = { hash: record.outputHash };
    }
    return { ...snapshot, artifacts };
}

/**
 * Build the report session-state runtime bound to a Postgres pool. The factory
 * closure captures the pool and constructs the session-state store and the thread
 * store from it, the same way the chat-turn preparation does.
 */
export function createReportSessionRuntime(deps: ReportSessionRuntimeDeps): ReportSessionRuntime {
    const { pool } = deps;
    const log = (deps.logger ?? createNoopLogger()).named("report-session-runtime");
    const store = createReportSessionStateStore({ pool, logger: deps.logger });
    const threads = createThreadStore(pool);

    /**
     * A store read or write fault, as a failed outcome. `corrupt_session_state`
     * names the part that cannot parse. A `DbError` carries its cause to the log.
     * The identifiers ride as structured fields, never in the message.
     */
    function storeFault(threadId: string, error: DbError | SessionStateReadError): EnsureSessionStateResult {
        if (error.type === "corrupt_session_state") {
            log.error("the stored session state cannot parse", { threadId, part: error.part });
            return { outcome: "failed", kind: "unavailable", detail: `the stored ${error.part} of the session state cannot parse` };
        }
        log.error("the session-state store failed", { threadId, ...log.errorFields(error.cause) });
        return { outcome: "failed", kind: "unavailable", detail: describeDbError(error) };
    }

    /**
     * Pin the snapshot and write the row. A pin failure writes no row, thus a
     * later run pins again. The write is insert-if-absent, thus two concurrent
     * first runs make one row and both read the winner back.
     *
     * The pin takes the workspace-root seam for the citation evidence. An absent
     * seam pins no citation, thus a citation block of the session resolves against
     * an empty list. The warning names that condition one time for each session.
     */
    async function pinAndWrite(threadId: string, analysisId: string): Promise<EnsureSessionStateResult> {
        if (deps.resolveWorkspaceRoot === undefined) {
            log.warn("the composition binds no workspace root, thus the pin carries no citation evidence", { threadId, analysisId });
        }
        const pinned = await pinReportSnapshot(pool, analysisId, deps.resolveWorkspaceRoot ? { resolveWorkspaceRoot: deps.resolveWorkspaceRoot } : {});
        if (pinned.isErr()) {
            log.error("the snapshot pin failed", { threadId, analysisId, kind: pinned.error.kind, ...log.errorFields(pinned.error.cause) });
            const detail = pinned.error.kind === "run-listing-failed" ? "the run listing read failed" : "the artifact ledger read failed";
            return { outcome: "failed", kind: "unavailable", detail };
        }
        const written = await store.writeSnapshot({ threadId, analysisId, snapshot: pinned.value });
        return written.match(
            (row): EnsureSessionStateResult => ({ outcome: "ready", state: row }),
            (error): EnsureSessionStateResult => storeFault(threadId, error),
        );
    }

    async function ensureSessionState(threadId: string): Promise<EnsureSessionStateResult> {
        const read = await store.readState(threadId);
        if (read.isErr()) {
            return storeFault(threadId, read.error);
        }
        if (read.value !== null) {
            // The row exists, thus the anchor holds and the pin stays single.
            return { outcome: "ready", state: read.value };
        }
        const thread = await threads.getThread(threadId);
        if (thread.isErr()) {
            log.error("the thread read failed", { threadId, ...log.errorFields(thread.error.cause) });
            return { outcome: "failed", kind: "unavailable", detail: describeDbError(thread.error) };
        }
        if (thread.value === null) {
            // The pin needs the analysis of the thread. An absent thread names none, and
            // the absence is a permanent condition.
            log.error("the thread resolves to no analysis", { threadId });
            return { outcome: "failed", kind: "absent-thread", detail: "the thread names no analysis" };
        }
        if (thread.value.threadType !== "report") {
            // The session anchors a report thread only. A conversation thread carries no report session,
            // thus a wrong type writes no row and the detail names the type. The wrong type is permanent.
            log.error("the thread is not a report thread", { threadId, threadType: thread.value.threadType });
            return { outcome: "failed", kind: "wrong-thread-type", detail: `the thread is a ${thread.value.threadType} thread, not a report thread` };
        }
        return pinAndWrite(threadId, thread.value.analysisId);
    }

    /**
     * Map the durable row onto the gateway load. A fresh row holds the snapshot and
     * no document, thus the load gives the empty draft. The found load carries the
     * stored analysis and the prior document as the concurrency token. A row with no
     * snapshot cannot serve a tool, because the pin writes the snapshot first.
     *
     * The served snapshot is the stored pin with the derivations merged onto it, thus a
     * tool reads one membership and it never merges again.
     */
    function toLoad(state: StoredSessionState): SessionStateLoad {
        if (state.snapshot === null) {
            log.error("the session-state row holds no snapshot", { threadId: state.threadId });
            return { outcome: "failed", detail: "the session state holds no snapshot" };
        }
        return {
            outcome: "found",
            state: { document: state.document ?? EMPTY_DRAFT, snapshot: serveMembership(state.snapshot, state.derivations) },
            analysisId: state.analysisId,
            token: state.document,
            seenDocumentHash: state.seenDocumentHash,
        };
    }

    const gateway: ReportSessionStateGateway = {
        async load(threadId: string): Promise<SessionStateLoad> {
            const ensured = await ensureSessionState(threadId);
            if (ensured.outcome === "failed") {
                switch (ensured.kind) {
                    case "absent-thread":
                        return { outcome: "absent" };
                    case "wrong-thread-type":
                        return { outcome: "wrong-type", detail: ensured.detail };
                    case "unavailable":
                        return { outcome: "failed", detail: ensured.detail };
                }
            }
            return toLoad(ensured.state);
        },
        async persist(threadId: string, document: DraftDocument, expected: SessionStateToken): Promise<SessionStatePersist> {
            const result = await store.persistDocument({ threadId, document, expected });
            return result.match(
                (outcome): SessionStatePersist => {
                    switch (outcome) {
                        case "persisted":
                            return { outcome: "persisted" };
                        case "conflict":
                            // A concurrent turn landed first. The turn refuses and reads the state again.
                            return { outcome: "conflict" };
                        case "absent":
                            // The pin writes the row first. A persist that finds no row means the
                            // pin-first invariant broke.
                            log.error("the session-state persist matched no row", { threadId });
                            return { outcome: "failed", detail: "no report session state row exists to persist the document" };
                    }
                },
                (error): SessionStatePersist => {
                    log.error("the session-state persist failed", { threadId, ...log.errorFields(error.cause) });
                    return { outcome: "failed", detail: describeDbError(error) };
                },
            );
        },
        async stampRendered(threadId: string, hash: string): Promise<StampResult> {
            const result = await store.stampRendered(threadId, hash);
            return result.match(
                (outcome): StampResult => (outcome === "stamped" ? { outcome: "stamped" } : { outcome: "absent" }),
                (error): StampResult => {
                    log.error("the rendered-hash stamp failed", { threadId, ...log.errorFields(error.cause) });
                    return { outcome: "failed", detail: describeDbError(error) };
                },
            );
        },
        async stampSeen(threadId: string): Promise<SeenStampResult> {
            const result = await store.stampSeen(threadId);
            return result.match(
                (outcome): SeenStampResult => {
                    switch (outcome) {
                        case "stamped":
                            return { outcome: "stamped" };
                        case "no-rendered":
                            // The row holds no rendered hash, thus no preview stamped one and the copy found
                            // none. The eyes direct a new preview from this arm.
                            return { outcome: "no-rendered" };
                        case "absent":
                            return { outcome: "absent" };
                    }
                },
                (error): SeenStampResult => {
                    log.error("the seen-hash stamp failed", { threadId, ...log.errorFields(error.cause) });
                    return { outcome: "failed", detail: describeDbError(error) };
                },
            );
        },
    };

    return { gateway, derivations: store, ensureSessionState };
}
