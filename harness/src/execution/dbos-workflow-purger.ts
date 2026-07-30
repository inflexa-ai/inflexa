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
 * The schema the engine keeps its ledger in. The raw SQL below names it literally,
 * `DBOSClient` defaults to it, and the schema probe asks after this same name — the
 * SDK accepts a `systemDatabaseSchemaName`, so moving a deployment's ledger has to
 * move all three together.
 */
const SYSTEM_SCHEMA = "dbos";

/**
 * SQLSTATE `undefined_table` — the answer both when the engine never created its
 * schema and when `workflow_status` is gone from beneath a schema that exists. Only
 * the first is nothing to purge, so the code on its own settles nothing.
 */
const UNDEFINED_TABLE = "42P01";

function isUndefinedTable(e: DbError): boolean {
    const cause: unknown = e.cause;
    return cause !== null && typeof cause === "object" && "code" in cause && cause.code === UNDEFINED_TABLE;
}

/**
 * Route the client's own diagnostics — pool errors and idle-client errors — onto
 * the injected sink. Left unset, the SDK builds a console logger of its own, and
 * a host whose UI owns stdout discards those records entirely.
 *
 * The SDK renders every entry to a string before delegating, and splits a failure
 * across both parameters: the text arrives as the entry, the stack — with any
 * `cause` chain already folded into it — as `metadata.stack`. So the entry is the
 * record's message at every level, `error` included, and engine wording stays
 * queryable in one place instead of the message at three levels and a field at the
 * fourth. The stack rides beside it under the key `defaultErrorFields` uses.
 * `errorFields` is not the tool here: it normalizes a thrown value, and an entry
 * the SDK has already rendered takes its `String(...)` branch, which emits a bare
 * message and drops the one stack the SDK bothered to hand over.
 */
function asEngineLogger(logger: Logger): DLogger {
    const render = (entry: unknown): string => (typeof entry === "string" ? entry : String(entry));
    return {
        debug: (entry) => logger.debug(render(entry)),
        info: (entry) => logger.info(render(entry)),
        warn: (entry) => logger.warn(render(entry)),
        error: (entry, metadata) => logger.error(render(entry), metadata?.stack === undefined ? undefined : { stack: metadata.stack }),
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
        // `create` never initializes the system database, and initialization is the
        // only path that reads the connection string once a pool is supplied — so the
        // url is unreachable from this client rather than merely untaken, and there is
        // none to thread through the seam.
        pending ??= DBOSClient.create({ systemDatabaseUrl: "", systemDatabasePool: pool, logger: asEngineLogger(logger) });
        return pending;
    };

    /**
     * Whether the engine's schema exists at all — the only thing that separates a
     * ledger the engine never created from one that is broken. It costs a round trip
     * only on the failure path that consults it, and a positive answer is memoized for
     * the purger's lifetime, since nothing drops the schema once the engine has made
     * it. A negative answer is deliberately not memoized: a purger can be built before
     * the launch that creates the schema, and caching absence would go on reading a
     * ledger that has since broken as one that was never there.
     */
    let schemaConfirmed = false;
    const systemSchemaExists = (): ResultAsync<boolean, DbError> => {
        if (schemaConfirmed) return okAsync(true);
        return tryQuery("workflowPurger.systemSchemaPresent", async () => {
            const { rows } = await pool.query<{ present: boolean }>({
                text: `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = $1) AS present`,
                values: [SYSTEM_SCHEMA],
            });
            return rows[0]?.present ?? false;
        }).map((present) => {
            schemaConfirmed = present;
            return present;
        });
    };

    /**
     * Recover a ledger the engine never created into `fallback`. A missing table
     * beneath a schema that does exist stays on the error channel along with every
     * other failure — an SDK rename, a manual drop, or a half-applied migration
     * reaches the caller as one, rather than as a purge that reclaimed nothing.
     */
    function whenLedgerAbsent<T>(fallback: T): (e: DbError) => ResultAsync<T, DbError> {
        return (e) =>
            isUndefinedTable(e) ? systemSchemaExists().andThen((present): ResultAsync<T, DbError> => (present ? errAsync(e) : okAsync(fallback))) : errAsync(e);
    }

    /**
     * How many ledger rows the delete is about to take, read immediately before it,
     * because the engine's delete reports no count of its own. This is a read only:
     * the walk it mirrors selects the same set the delete targets — requested ids that
     * exist, plus their descendants when asked — while the delete itself and its
     * cascades stay engine-owned.
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
                // Descendants too: the delete side reaches them, so roots-only
                // cancellation would leave child step executors writing behind it.
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
