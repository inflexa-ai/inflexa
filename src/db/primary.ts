import { Database } from "bun:sqlite";
import { type Result, ok, err } from "neverthrow";
import { env } from "../lib/env.ts";
import { ensureDir } from "./util.ts";
import { migrations, runMigrations } from "./primary_migrations.ts";
import type { DbError } from "./errors.ts";

let _db: Database | null = null;

export function db(): Result<Database, DbError> {
    if (_db) return ok(_db);

    let conn: Database;
    try {
        ensureDir(env.dbPath);
        conn = new Database(env.dbPath);
        conn.run("PRAGMA journal_mode = WAL");
        conn.run("PRAGMA synchronous = NORMAL");
        conn.run("PRAGMA busy_timeout = 5000");
        conn.run("PRAGMA cache_size = -64000");
        conn.run("PRAGMA foreign_keys = ON");
    } catch (cause) {
        return err({ type: "connection_failed", cause });
    }

    return runMigrations(conn, migrations).map(() => {
        _db = conn;
        return conn;
    });
}

/**
 * Closes and forgets the shared connection so the next {@link db} call reopens (and re-migrates) a
 * fresh database. Exists solely for the test harness, which resets the singleton between integration
 * tests (src/test_support/db.ts). Production never closes it: the CLI is short-lived and the OS
 * reclaims the handle on exit, so shutdown.ts deliberately doesn't bother.
 */
export function closeDb(): void {
    _db?.close();
    _db = null;
}
