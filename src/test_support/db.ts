import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

import { env } from "../lib/env.ts";
import { closeDb, db } from "../db/primary.ts";

/**
 * Drops the shared SQLite connection and deletes the on-disk database (plus its WAL sidecars), so the
 * next {@link db} call reopens and re-migrates an empty database. The sandbox directory itself is
 * established by the test preload (src/test_support/preload.ts); this only resets the DB *within* it.
 */
export function resetDb(): void {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(env.dbPath + suffix, { force: true });
    }
}

/**
 * Returns a freshly-migrated shared database for an integration test: resets any prior state, then
 * reopens + migrates. The returned connection is the same singleton the db/ query and mutation
 * functions use internally (they call {@link db}), so a test can drive them and then read rows back.
 * A failed migration throws — a broken harness must fail loudly, not hand back a half-open DB.
 */
export function freshDb(): Database {
    resetDb();
    return db()._unsafeUnwrap();
}
