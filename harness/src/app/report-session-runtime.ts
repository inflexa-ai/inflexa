/**
 * The report session-state runtime -- the durable realization of the session-state
 * gateway, and the idempotent operation that anchors one report session.
 *
 * The runtime binds three parts: the session-state store, the thread store, and
 * the mint. The tool layer speaks the gateway, and the gateway speaks a plain
 * discriminated value. Thus the neverthrow of the store stays inside this module,
 * and it never crosses the tool boundary.
 *
 * `ensureSessionState` makes sure that the row of a thread exists. The first run
 * resolves the analysis of the thread, mints the snapshot, and writes the row. A
 * later run reads the row and mints nothing. The store insert-if-absent keeps two
 * concurrent first runs to one row. A mint failure writes no row and returns as
 * typed data, thus a later run mints again.
 *
 * The gateway `load` runs the same operation, thus a tool call never arrives
 * before the state exists. A fresh row holds the snapshot and no document yet.
 * Thus `load` gives the empty draft with the stored snapshot, because the mint
 * writes the snapshot first and the document lands later.
 *
 * A store fault, an absent thread, and a mint failure each ride the failed arm
 * with a short detail. The diagnostic goes to the injected `Logger`, never to the
 * detail alone.
 */

import type { Pool } from "pg";

import { createNoopLogger } from "../lib/console-logger.js";
import { describeDbError, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import { createThreadStore } from "../memory/thread-store.js";
import type { DraftDocument } from "../report-model/draft.js";
import { mintReportSnapshot } from "../report-model/mint-snapshot.js";
import { createReportSessionStateStore, type ReportSessionState as StoredSessionState, type SessionStateReadError } from "../state/report-session-state.js";
import type { ReportSessionStateGateway, SessionStateLoad, SessionStatePersist } from "../tools/report-authoring/authoring-tools.js";

/** The empty draft of a fresh session. The mint writes the snapshot first, thus the document is empty here. */
const EMPTY_DRAFT: DraftDocument = { title: "", sections: [] };

/**
 * The outcome of the anchor operation. `ready` carries the durable row, whose
 * document is `null` until the first document lands. `failed` names the cause as a
 * short detail, and the runtime logs the diagnostic beside it.
 */
export type EnsureSessionStateResult = { outcome: "ready"; state: StoredSessionState } | { outcome: "failed"; detail: string };

export interface ReportSessionRuntimeDeps {
    readonly pool: Pool;
    readonly logger?: Logger;
}

/**
 * The report session-state runtime. The gateway serves the authoring tools, and
 * `ensureSessionState` anchors the session. The serving path of a report turn runs
 * `ensureSessionState` at the turn start, and the gateway `load` runs it too, thus
 * a tool call cannot arrive before the state exists.
 */
export interface ReportSessionRuntime {
    readonly gateway: ReportSessionStateGateway;
    ensureSessionState(threadId: string): Promise<EnsureSessionStateResult>;
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
            return { outcome: "failed", detail: `the stored ${error.part} of the session state cannot parse` };
        }
        log.error("the session-state store failed", { threadId, ...log.errorFields(error.cause) });
        return { outcome: "failed", detail: describeDbError(error) };
    }

    /**
     * Mint the snapshot and write the row. A mint failure writes no row, thus a
     * later run mints again. The write is insert-if-absent, thus two concurrent
     * first runs make one row and both read the winner back.
     */
    async function mintAndWrite(threadId: string, analysisId: string): Promise<EnsureSessionStateResult> {
        const minted = await mintReportSnapshot(pool, analysisId);
        if (minted.isErr()) {
            log.error("the snapshot mint failed", { threadId, analysisId, ...log.errorFields(minted.error.cause) });
            return { outcome: "failed", detail: "the artifact ledger read failed" };
        }
        const written = await store.writeSnapshot({ threadId, analysisId, snapshot: minted.value });
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
            // The row exists, thus the anchor holds and the mint stays single.
            return { outcome: "ready", state: read.value };
        }
        const thread = await threads.getThread(threadId);
        if (thread.isErr()) {
            log.error("the thread read failed", { threadId, ...log.errorFields(thread.error.cause) });
            return { outcome: "failed", detail: describeDbError(thread.error) };
        }
        if (thread.value === null) {
            // The mint needs the analysis of the thread. An absent thread names none.
            log.error("the thread resolves to no analysis", { threadId });
            return { outcome: "failed", detail: "the thread names no analysis" };
        }
        if (thread.value.threadType !== "report") {
            // The session anchors a report thread only. A conversation thread carries no report session,
            // thus a wrong type writes no row and the detail names the type.
            log.error("the thread is not a report thread", { threadId, threadType: thread.value.threadType });
            return { outcome: "failed", detail: `the thread is a ${thread.value.threadType} thread, not a report thread` };
        }
        return mintAndWrite(threadId, thread.value.analysisId);
    }

    /**
     * Map the durable row onto the gateway load. A fresh row holds the snapshot and
     * no document, thus the load gives the empty draft. A row with no snapshot cannot
     * serve a tool, because the mint writes the snapshot first.
     */
    function toLoad(state: StoredSessionState): SessionStateLoad {
        if (state.snapshot === null) {
            log.error("the session-state row holds no snapshot", { threadId: state.threadId });
            return { outcome: "failed", detail: "the session state holds no snapshot" };
        }
        return { outcome: "found", state: { document: state.document ?? EMPTY_DRAFT, snapshot: state.snapshot } };
    }

    const gateway: ReportSessionStateGateway = {
        async load(threadId: string): Promise<SessionStateLoad> {
            const ensured = await ensureSessionState(threadId);
            if (ensured.outcome === "failed") {
                return { outcome: "failed", detail: ensured.detail };
            }
            return toLoad(ensured.state);
        },
        async persist(threadId: string, document: DraftDocument): Promise<SessionStatePersist> {
            const result = await store.persistDocument({ threadId, document });
            return result.match(
                (updated): SessionStatePersist => {
                    if (updated) {
                        return { outcome: "persisted" };
                    }
                    // The mint writes the row first. A persist that updates no row means the
                    // mint-first invariant broke.
                    log.error("the session-state persist matched no row", { threadId });
                    return { outcome: "failed", detail: "no report session state row exists to persist the document" };
                },
                (error): SessionStatePersist => {
                    log.error("the session-state persist failed", { threadId, ...log.errorFields(error.cause) });
                    return { outcome: "failed", detail: describeDbError(error) };
                },
            );
        },
    };

    return { gateway, ensureSessionState };
}
