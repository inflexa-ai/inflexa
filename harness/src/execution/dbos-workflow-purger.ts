/**
 * DBOS realization of the `WorkflowPurger` seam — the single production adapter,
 * shared by every embedder. Host-neutral: it references only DBOS, which the
 * harness already depends on.
 *
 * It is built on `DBOSClient`, not the static `DBOS` facade. The facade's
 * workflow-management calls require a launched engine and throw without one,
 * which would make a purge impossible from exactly the process that needs it
 * most: a headless command holding nothing but a pool. `DBOSClient` accepts a
 * pre-built pool and needs no launch, so one realization serves a booted host and
 * a headless one alike and no embedder has to choose between two purgers. The
 * engine's system database is the same database as the application pool, so the
 * injected pool already reaches the ledger.
 *
 * The engine owns the deletion itself, including the breadth-first walk over
 * `parent_workflow_id` that reaches child step workflows. Its single
 * `DELETE FROM dbos.workflow_status WHERE workflow_uuid = ANY(...)` is all the
 * dependent tables need: step outputs, streams, inputs, events, notifications,
 * and queue rows each hold an `ON DELETE CASCADE` foreign key to
 * `workflow_status`, so they go with the status row.
 */

import { DBOSClient, type DLogger } from "@dbos-inc/dbos-sdk";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { Pool } from "pg";

import { createNoopLogger } from "../lib/console-logger.js";
import { tryMutation, tryQuery, type DbError } from "../lib/db-result.js";
import type { Logger } from "../lib/logger.js";
import type { WorkflowPurger } from "./workflow-purger.js";

/**
 * SQLSTATE `undefined_table`. The engine creates its schema on first launch, so a
 * deployment that has never launched one has no ledger at all — an absent ledger
 * is nothing to purge rather than a failed purge.
 */
const UNDEFINED_TABLE = "42P01";

function ledgerIsAbsent(e: DbError): boolean {
    const cause: unknown = e.cause;
    return cause !== null && typeof cause === "object" && "code" in cause && cause.code === UNDEFINED_TABLE;
}

/** Recover an absent ledger into `fallback`; every other failure stays on the error channel. */
function whenLedgerAbsent<T>(fallback: T): (e: DbError) => ResultAsync<T, DbError> {
    return (e) => (ledgerIsAbsent(e) ? okAsync(fallback) : errAsync(e));
}

/**
 * Route the client's own diagnostics — pool errors and idle-client errors — onto
 * the injected sink. Left unset, the SDK builds a console logger of its own, and
 * a host whose UI owns stdout discards those records entirely.
 */
function asEngineLogger(logger: Logger): DLogger {
    const render = (entry: unknown): string => (typeof entry === "string" ? entry : String(entry));
    return {
        debug: (entry) => logger.debug(render(entry)),
        info: (entry) => logger.info(render(entry)),
        warn: (entry) => logger.warn(render(entry)),
        error: (entry) => logger.error("engine client failure", logger.errorFields(entry)),
    };
}

export interface DbosWorkflowPurgerDeps {
    /** Pool onto the engine's system database — the same database the application pool holds. */
    readonly pool: Pool;
    readonly logger?: Logger;
}

export function createDbosWorkflowPurger({ pool, logger: injected }: DbosWorkflowPurgerDeps): WorkflowPurger {
    const logger = (injected ?? createNoopLogger()).named("workflow-purger");

    // One client per factory, not per call. Creating a client does no I/O, but the
    // client registers `error` and `connect` handlers on the pool it is handed, so a
    // client per purge would accumulate handler pairs on a long-lived pool. Its
    // `destroy()` ends that pool, so a client over an injected pool must never be
    // destroyed either — which leaves a per-call client nothing to release. Creation
    // is lazy so building a purger stays free for a host that never purges.
    let pending: Promise<DBOSClient> | undefined;
    const engine = (): Promise<DBOSClient> => {
        // The connection string is read only when the client builds its own pool, and
        // by the schema-migration path this client never runs. A pool is supplied
        // here, so there is no url to thread through the seam.
        pending ??= DBOSClient.create({ systemDatabaseUrl: "", systemDatabasePool: pool, logger: asEngineLogger(logger) });
        return pending;
    };

    /**
     * How many ledger rows the delete is about to take, read immediately before it.
     * The engine's delete reports no count, and the count is what lets a caller
     * narrate what it reclaimed and see zero for an analysis already purged. This is
     * a read only: the walk it mirrors selects the same set the delete targets —
     * requested ids that exist, plus their descendants when asked — while the delete
     * itself and its cascades stay engine-owned.
     */
    const countDoomed = (workflowIds: string[], includeDescendants: boolean): ResultAsync<number, DbError> =>
        tryQuery("workflowPurger.countDoomed", async () => {
            const { rows } = await pool.query<{ total: number }>(
                includeDescendants
                    ? {
                          // The non-recursive term unnests the requested ids rather than
                          // reading them out of the ledger, so a descendant is still
                          // reached when the id it descends from has already been
                          // removed; the outer count then keeps only rows that exist.
                          text: `WITH RECURSIVE doomed AS (
                                     SELECT unnest($1::text[]) AS workflow_uuid
                                     UNION
                                     SELECT child.workflow_uuid
                                       FROM dbos.workflow_status child
                                       JOIN doomed ON child.parent_workflow_id = doomed.workflow_uuid
                                 )
                                 SELECT COUNT(*)::int AS total
                                 FROM dbos.workflow_status
                                 WHERE workflow_uuid IN (SELECT workflow_uuid FROM doomed)`,
                          values: [workflowIds],
                      }
                    : {
                          text: `SELECT COUNT(*)::int AS total FROM dbos.workflow_status WHERE workflow_uuid = ANY($1)`,
                          values: [workflowIds],
                      },
            );
            return rows[0]?.total ?? 0;
        });

    return {
        findByIdPrefix(prefix) {
            return tryQuery("workflowPurger.findByIdPrefix", async () => {
                const { rows } = await pool.query<{ workflow_uuid: string }>({
                    // `starts_with` rather than a parameterized LIKE pattern: a namespace
                    // carrying `_` or `%` would match as a wildcard there and sweep in
                    // workflows belonging to a different analysis.
                    text: `SELECT workflow_uuid FROM dbos.workflow_status WHERE starts_with(workflow_uuid, $1)`,
                    values: [prefix],
                });
                return rows.map((row) => row.workflow_uuid);
            }).orElse(whenLedgerAbsent<string[]>([]));
        },

        cancel(workflowIds) {
            if (workflowIds.length === 0) return okAsync(undefined);
            return tryMutation("workflowPurger.cancel", async () => {
                const client = await engine();
                // Descendants are cancelled too. The delete side reaches them, so a cancel
                // that stopped only the roots would leave child step executors running and
                // re-materializing rows the delete has already taken.
                await client.cancelWorkflows([...workflowIds], { cancelChildren: true });
            })
                .map(() => {
                    logger.debug("cancelled workflows", { requested: workflowIds.length });
                })
                .orElse(whenLedgerAbsent<void>(undefined));
        },

        deleteWorkflows(workflowIds, includeDescendants = false) {
            if (workflowIds.length === 0) return okAsync(0);
            const ids = [...workflowIds];
            return countDoomed(ids, includeDescendants)
                .andThen((doomed) =>
                    tryMutation("workflowPurger.deleteWorkflows", async () => {
                        const client = await engine();
                        await client.deleteWorkflows(ids, includeDescendants);
                        return doomed;
                    }),
                )
                .map((deleted) => {
                    logger.debug("deleted workflows", { deleted, includeDescendants });
                    return deleted;
                })
                .orElse(whenLedgerAbsent(0));
        },
    };
}
