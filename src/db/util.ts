import { Database, SQLiteError } from "bun:sqlite";
import { type Result, ok, err } from "neverthrow";
import type { ConstraintKind, DbError } from "./errors.ts";
import { db } from "./primary.ts";

/** Runs a read against the shared connection, wrapping a thrown error as `query_failed`. Absence is the callback's concern (it returns `null`), never an error here. */
export function tryQuery<T>(op: string, fn: (conn: Database) => T): Result<T, DbError> {
    try {
        return db().andThen((conn) => ok(fn(conn)));
    } catch (cause) {
        return err({ type: "query_failed", op, cause });
    }
}

/** Runs a write against the shared connection. A tripped DB constraint becomes a typed `constraint_violation`; any other throw is `mutation_failed`. */
export function tryMutation<T>(op: string, fn: (conn: Database) => T): Result<T, DbError> {
    try {
        return db().andThen((conn) => ok(fn(conn)));
    } catch (cause) {
        return err(mutationError(op, cause));
    }
}

/**
 * Runs `fn`'s writes in one SQLite transaction: they commit together, or roll back together
 * if `fn` yields an `err`. Reach for this whenever a single logical change spans multiple
 * mutations (e.g. a message and its first part) so a mid-way failure can't leave a partial.
 */
export function withTransaction<T>(op: string, fn: () => Result<T, DbError>): Result<T, DbError> {
    return db().andThen((conn) => {
        try {
            // bun's transaction() rolls back only when its callback throws, but our mutations
            // report failure by returning `err`. Bridge the two: re-throw the DbError (boxed in
            // TxAbort) to force the rollback, then unwrap it back into the Result in the catch.
            let value!: T;

            conn.transaction(() => {
                fn().match(
                    (v) => {
                        value = v;
                    },
                    (e) => {
                        throw new TxAbort(e);
                    },
                );
            })();
            return ok(value);
        } catch (cause) {
            if (cause instanceof TxAbort) return err(cause.dbError);
            return err(mutationError(op, cause));
        }
    });
}

/** Boxes a mutation's `DbError` so it survives bun's throw-to-rollback and the original failure (not a generic wrap) reaches the caller. */
class TxAbort extends Error {
    constructor(readonly dbError: DbError) {
        super("transaction aborted");
    }
}

/** Maps a thrown DB error to a typed `constraint_violation` when SQLite reports a constraint code, else a generic `mutation_failed`. */
function mutationError(op: string, cause: unknown): DbError {
    const constraint = constraintOf(cause);
    return constraint ? { type: "constraint_violation", constraint, op, cause } : { type: "mutation_failed", op, cause };
}

/** Classifies a SQLite failure by its constraint code; `null` for any non-constraint error. */
function constraintOf(cause: unknown): ConstraintKind | null {
    if (!(cause instanceof SQLiteError)) return null;
    switch (cause.code) {
        // A primary-key clash is a uniqueness violation from the caller's perspective.
        case "SQLITE_CONSTRAINT_UNIQUE":
        case "SQLITE_CONSTRAINT_PRIMARYKEY":
            return "unique";
        case "SQLITE_CONSTRAINT_FOREIGNKEY":
            return "foreign_key";
        case "SQLITE_CONSTRAINT_NOTNULL":
            return "not_null";
        case "SQLITE_CONSTRAINT_CHECK":
            return "check";
        default:
            return null;
    }
}

/** A single forward-only schema step, applied in `version` order and recorded in `_migrations`. */
export type Migration = {
    version: number;
    up: string;
};

export function ensureDir(path: string) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    try {
        Bun.spawnSync(["mkdir", "-p", dir]);
    } catch {
        // best effort
    }
}
