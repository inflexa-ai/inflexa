/**
 * Report-session spawn — the host-agnostic operation that makes a `report`
 * child thread from a conversation.
 *
 * The operation owns no table. It composes four reads and writes the store and
 * the thread history already give: `getThread` for the parent, `latestSeq` for
 * the anchor, `listThreads` for the count of report children, and
 * `createThread` for the insert. The one storage read this capability adds,
 * `latestSeq`, lives on the thread history, because that module owns the
 * `messages` table.
 *
 * The reads and the insert take no lock and no transaction. A concurrent turn
 * can append between the anchor read and the insert, and a retract can cut the
 * parent's tail. A transaction cannot keep the parent still one turn later, so
 * a lock buys no real guarantee. The anchor records the spawn point, and skew
 * past the parent's current end is a normal state a reader expects.
 *
 * A conversation thread id comes from the host UI. But the spawn is a harness
 * operation with no UI in front of it. Thus it mints a `randomUUID` and returns
 * the full row. A managed deployment gets the same behavior with no host code.
 */

import { randomUUID } from "node:crypto";

import { type ResultAsync, errAsync } from "neverthrow";
import type { Pool } from "pg";

import type { DbError } from "../lib/db-result.js";
import type { DomainError } from "../lib/result.js";
import { createThreadHistory } from "../memory/thread-history.js";
import { createThreadStore, type Thread, type ThreadInputError, type ThreadPage, type ThreadType } from "../memory/thread-store.js";

/**
 * A spawn the operation refuses before it writes a row. Distinct from
 * `DbError`: nothing failed at the driver — the parent names a session the
 * spawn refuses, and each variant carries the identifiers that say which values
 * disagreed.
 *
 * The set is closed. `parent_not_found` covers an absent parent and an archived
 * one alike, because `getThread` filters the tombstone and a spawn into hidden
 * state is not permitted. `parent_not_a_conversation` keeps the tree flat: a
 * report session cannot spawn another. `empty_parent_transcript` refuses a
 * report on a parent that holds no messages, because such a report reports
 * nothing.
 */
export type SpawnRefusal =
    | {
          readonly type: "parent_not_found";
          readonly op: string;
          readonly parentThreadId: string;
      }
    | {
          readonly type: "parent_not_a_conversation";
          readonly op: string;
          readonly parentThreadId: string;
          readonly threadType: ThreadType;
      }
    | {
          readonly type: "empty_parent_transcript";
          readonly op: string;
          readonly parentThreadId: string;
      };

// SpawnRefusal is a `DomainError` (string `type`) — the compile-time check keeps
// it inside the cross-subsystem error vocabulary.
type _AssertDomainError = SpawnRefusal extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/** The paging inputs `listReportSessions` forwards to the thread listing. */
export interface ReportSessionPaging {
    readonly page?: number;
    readonly perPage?: number;
}

export interface ReportSessionSpawnDeps {
    readonly pool: Pool;
}

export interface ReportSessionSpawn {
    /**
     * Make a `report` child of the parent conversation and return the full row.
     * The child takes the analysis of the parent, the parent thread id, and the
     * anchor — the parent's latest `messages.seq` at this moment.
     *
     * Refused with a `SpawnRefusal`, no row written: an absent or archived
     * parent, a parent that is not a conversation, and a parent with no
     * messages. A store refusal (`DbError`, `ThreadInputError`) passes through
     * unchanged.
     */
    spawnReportSession(parentThreadId: string): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError>;
    /**
     * The report sessions of one analysis, through the thread listing narrowed
     * to the type `report`. It adds no predicate of its own, so its answer and
     * the thread listing cannot disagree.
     */
    listReportSessions(analysisId: string, paging?: ReportSessionPaging): ResultAsync<ThreadPage, DbError>;
}

const OP = "spawn-report-session";

/**
 * Compose the child title. N counts the existing report children of the parent
 * plus one. A parent with no title yields `Report N` alone, because the seed of
 * the parent title is best-effort and can be absent.
 */
function composeTitle(parentTitle: string | null, n: number): string {
    const suffix = `Report ${n}`;
    return parentTitle && parentTitle.length > 0 ? `${parentTitle} — ${suffix}` : suffix;
}

/**
 * Build the report-session operations bound to a Postgres pool. The factory
 * closure captures `pool` and constructs the store and the thread history from
 * it, the same way the chat-turn preparation does.
 */
export function createReportSessionSpawn(deps: ReportSessionSpawnDeps): ReportSessionSpawn {
    const { pool } = deps;
    const store = createThreadStore(pool);
    const history = createThreadHistory(pool);

    function spawnReportSession(parentThreadId: string): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> {
        return store.getThread(parentThreadId).andThen((parent): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> => {
            // An absent parent and an archived one arrive the same way — `getThread`
            // filters the tombstone — and both refuse as `parent_not_found`.
            if (parent === null) {
                return errAsync({ type: "parent_not_found", op: OP, parentThreadId });
            }
            // The tree stays flat: only a conversation spawns a report.
            if (parent.threadType !== "conversation") {
                return errAsync({ type: "parent_not_a_conversation", op: OP, parentThreadId, threadType: parent.threadType });
            }
            return history.latestSeq(parentThreadId).andThen((anchor): ResultAsync<Thread, SpawnRefusal | DbError | ThreadInputError> => {
                // `null` is a parent with no messages. A report on an empty transcript
                // reports nothing, so the refusal is the correct answer.
                if (anchor === null) {
                    return errAsync({ type: "empty_parent_transcript", op: OP, parentThreadId });
                }
                // `total`, not the page length: N counts every existing report child,
                // not the count on one page. Two concurrent spawns can compose one N.
                // The result is two titles a user renames, and no identifier collides.
                return store
                    .listThreads({ analysisId: parent.analysisId, type: "report", parentThreadId })
                    .andThen((children): ResultAsync<Thread, DbError | ThreadInputError> =>
                        store.createThread({
                            threadId: randomUUID(),
                            analysisId: parent.analysisId,
                            title: composeTitle(parent.title, children.total + 1),
                            type: "report",
                            parentThreadId,
                            parentSeq: anchor,
                        }),
                    );
            });
        });
    }

    function listReportSessions(analysisId: string, paging: ReportSessionPaging = {}): ResultAsync<ThreadPage, DbError> {
        return store.listThreads({ analysisId, type: "report", ...paging });
    }

    return { spawnReportSession, listReportSessions };
}
