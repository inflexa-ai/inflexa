import { Database } from "bun:sqlite";
import { ulid } from "ulid";
import { type Result, ok, err } from "neverthrow";
import type { DbError } from "./errors.ts";
import { db } from "./primary.ts";

export function tryQuery<T>(op: string, fn: (conn: Database) => T): Result<T, DbError> {
    try {
        return db().andThen((conn) => ok(fn(conn)));
    } catch (cause) {
        return err({ type: "query_failed", op, cause });
    }
}

export function tryMutation<T>(op: string, fn: (conn: Database) => T): Result<T, DbError> {
    try {
        return db().andThen((conn) => ok(fn(conn)));
    } catch (cause) {
        return err({ type: "mutation_failed", op, cause });
    }
}

export type Migration = {
    version: number;
    up: string;
};

export function newId(): string {
    return ulid();
}

export function ensureDir(path: string) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    try {
        Bun.spawnSync(["mkdir", "-p", dir]);
    } catch {
        // best effort
    }
}
