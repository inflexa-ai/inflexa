/**
 * Postgres data-access Result glue for cortex.
 *
 * The data-access layer (`state/`, `memory/`, vector-store, regulatory-corpus)
 * models failure as values: every function returns `ResultAsync<T, DbError>`.
 * The ONLY `try/catch` lives here, at the `pg` driver call — these three
 * wrappers turn a driver throw into an `err(DbError)`; everything above them
 * flows `ResultAsync`.
 *
 * House rules realized here (see `lib/result.ts`):
 *  - Absence is NOT an error. A missing row stays in the ok channel as a data
 *    variant (`ok(null)` / `ok([])`), never an `err`. `DbError` is reserved for
 *    a genuine driver/connection/constraint failure.
 *  - Control-flow exceptions (DBOS cancellation, `AbortError`) are NOT failures
 *    and are never captured as a `DbError`: the single-statement wrappers below
 *    only ever see driver throws, and `withTransaction` never catches a throw
 *    that escapes `fn` — a control-flow exception propagates untouched to the
 *    workflow-call seam (its `finally` only rolls back and releases).
 *
 * Consumers unwrap per their edge: HTTP routes `.match(...)`; DBOS step bodies
 * `resultStep(runStep)` / `unwrapOrThrow`; tool `execute` bodies `unwrapOrThrow`
 * (a throw becomes an `is_error` tool_result via dispatch).
 */

import { ResultAsync, err, ok } from "neverthrow";
import type { Pool, PoolClient } from "pg";

import type { DomainError } from "./result.js";

/** A query/mutation/connection accepted by the data-access layer. */
type Querier = Pool | PoolClient;

/**
 * A storage-layer failure. Absence is deliberately NOT modelled: single-row
 * reads return `ok(T | null)` and mutations against a missing row return
 * `ok(0 rows)`, so "not found" rides the ok channel. `DbError` is reserved for
 * driver-level failures — a failed read, a failed write, a constraint trip, or
 * a lost connection. `op` is a stable, human-readable label (e.g.
 * `"runs.insertRun"`) used by `describeDbError` and in logs.
 */
export type DbError =
    | { readonly type: "query_failed"; readonly op: string; readonly cause: unknown }
    | { readonly type: "mutation_failed"; readonly op: string; readonly cause: unknown }
    | { readonly type: "connection_failed"; readonly op: string; readonly cause: unknown }
    | {
          readonly type: "constraint_violation";
          readonly op: string;
          readonly constraint: string;
          readonly cause: unknown;
      };

// DbError is a `DomainError` (string `type` + `cause`) — the compile-time
// check keeps it inside the cross-subsystem error vocabulary.
type _AssertDomainError = DbError extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/** pg SQLSTATE classes that mean "connection is gone", mapped to `connection_failed`. */
const CONNECTION_SQLSTATE = new Set([
    "08000", // connection_exception
    "08003", // connection_does_not_exist
    "08006", // connection_failure
    "08001", // sqlclient_unable_to_establish_sqlconnection
    "08004", // sqlserver_rejected_establishment_of_sqlconnection
    "57P01", // admin_shutdown
    "57P02", // crash_shutdown
    "57P03", // cannot_connect_now
]);

/** pg SQLSTATE → the violated constraint kind, for `constraint_violation`. */
const CONSTRAINT_SQLSTATE: Record<string, string> = {
    "23505": "unique",
    "23503": "foreign_key",
    "23502": "not_null",
    "23514": "check",
};

function sqlstate(cause: unknown): string | undefined {
    if (cause && typeof cause === "object" && "code" in cause) {
        const code = (cause as { code?: unknown }).code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}

/** pg surfaces the tripped constraint's name on `.constraint`. */
function constraintName(cause: unknown): string {
    if (cause && typeof cause === "object" && "constraint" in cause) {
        const name = (cause as { constraint?: unknown }).constraint;
        if (typeof name === "string" && name.length > 0) return name;
    }
    return "unknown";
}

/** A read throw → `connection_failed` for a connection SQLSTATE, else `query_failed`. */
function readError(op: string, cause: unknown): DbError {
    const code = sqlstate(cause);
    if (code && CONNECTION_SQLSTATE.has(code)) {
        return { type: "connection_failed", op, cause };
    }
    return { type: "query_failed", op, cause };
}

/**
 * A write throw → `constraint_violation` for a constraint SQLSTATE (carrying
 * the constraint name), `connection_failed` for a connection SQLSTATE, else
 * `mutation_failed`.
 */
function writeError(op: string, cause: unknown): DbError {
    const code = sqlstate(cause);
    if (code && code in CONSTRAINT_SQLSTATE) {
        return {
            type: "constraint_violation",
            op,
            constraint: constraintName(cause),
            cause,
        };
    }
    if (code && CONNECTION_SQLSTATE.has(code)) {
        return { type: "connection_failed", op, cause };
    }
    return { type: "mutation_failed", op, cause };
}

/** A one-line, user-facing description of a `DbError` for logs and error bodies. */
export function describeDbError(e: DbError): string {
    switch (e.type) {
        case "query_failed":
            return `database read failed (${e.op})`;
        case "mutation_failed":
            return `database write failed (${e.op})`;
        case "connection_failed":
            return `database connection failed (${e.op})`;
        case "constraint_violation":
            return `database constraint "${e.constraint}" violated (${e.op})`;
    }
}

/**
 * Wrap a read. A `pg` throw becomes `err(query_failed)` — or
 * `err(connection_failed)` for a connection SQLSTATE. Absence is the body's
 * concern: return `ok(null)` / `ok([])` from `fn` for a missing row.
 *
 * `fn` runs the driver call and returns the already-mapped value (`T`). Keep
 * `fn` to the single `await querier.query(...)` plus its row-mapping; do not
 * embed control-flow that could throw a non-driver error.
 */
export function tryQuery<T>(op: string, fn: () => Promise<T>): ResultAsync<T, DbError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                return err(readError(op, cause));
            }
        })(),
    );
}

/**
 * Wrap a write. A `pg` throw becomes `err(mutation_failed)`, mapped to
 * `err(constraint_violation{constraint})` for SQLSTATE 23505/23503/23502/23514
 * and `err(connection_failed)` for a connection SQLSTATE.
 */
export function tryMutation<T>(op: string, fn: () => Promise<T>): ResultAsync<T, DbError> {
    return new ResultAsync(
        (async () => {
            try {
                return ok(await fn());
            } catch (cause) {
                return err(writeError(op, cause));
            }
        })(),
    );
}

/**
 * Best-effort `ROLLBACK`: on a poisoned/closed connection it may itself throw;
 * the original failure is what matters (an aborted transaction never
 * committed), and `release()` reclaims the connection regardless.
 */
async function rollbackQuietly(client: PoolClient): Promise<void> {
    try {
        await client.query("ROLLBACK");
    } catch {
        /* connection already gone — release covers it */
    }
}

/**
 * Run `fn`'s statements in one transaction against a dedicated `PoolClient`:
 * `BEGIN`, run `fn(client)`, `COMMIT` on `ok`, `ROLLBACK` on `err`. `fn`
 * receives the transaction's `client` — every statement inside MUST use it,
 * not the pool.
 *
 * CRITICAL FOOTGUN: the `pg` driver rolls back a transaction only when its
 * callback throws, but our mutations report failure by returning `err`. So
 * `withTransaction` rolls back itself whenever `fn` does not reach `COMMIT`.
 * Build the transaction body as a single `ResultAsync` chain whose first `err`
 * short-circuits to `fn`'s result — do NOT `.match`/swallow a mid-transaction
 * `err` inside `fn`, or that statement commits with the rest.
 *
 * `connect` / `BEGIN` / `COMMIT` driver errors become `err`. A throw that
 * escapes `fn` itself is NEVER caught here — a control-flow exception (DBOS
 * cancellation, `AbortError`) is DBOS's own signalling and must reach the
 * workflow-call seam untouched; the `finally` only rolls back the open
 * transaction and releases the connection so a cancelled tx never poisons the
 * pool.
 */
export function withTransaction<T>(pool: Pool, op: string, fn: (client: PoolClient) => ResultAsync<T, DbError>): ResultAsync<T, DbError> {
    return new ResultAsync(
        (async () => {
            let client: PoolClient;
            try {
                client = await pool.connect();
            } catch (cause) {
                return err(writeError(op, cause));
            }
            let committed = false;
            try {
                const begun = await tryMutation(`${op}:begin`, () => client.query("BEGIN"));
                if (begun.isErr()) return err(begun.error);

                const inner = await fn(client);
                if (inner.isErr()) return err(inner.error);

                const done = await tryMutation(`${op}:commit`, () => client.query("COMMIT"));
                if (done.isErr()) return err(done.error);

                committed = true;
                return ok(inner.value);
            } finally {
                if (!committed) await rollbackQuietly(client);
                client.release();
            }
        })(),
    );
}

export type { Querier };
