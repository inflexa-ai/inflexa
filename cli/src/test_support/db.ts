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
    // Destructive-reset guard. The rmSync below deletes env.dbPath + its WAL sidecars; if the test
    // preload never ran, env.dbPath resolves to the developer's REAL ~/.local/share/inflexa/agent.db
    // and this would delete their live database (it happened live — `bun test` from the repo root
    // skips cli/bunfig.toml, so preload.ts never redirects XDG_* nor stamps the marker). Require the
    // marker AND that env.dbPath actually sits inside the stamped sandbox before deleting anything.
    //
    // throw (not Result) is the right channel here: this is test-support code, so failing the run
    // loudly IS the correct outcome — a returned Err would let a careless caller ignore it and go on
    // to destroy real data, which is exactly what this guard exists to prevent (per CLAUDE.md's
    // throw policy, a test-harness boundary that must abort the suite rather than continue).
    const sandbox = process.env.INFLEXA_TEST_SANDBOX;
    if (!sandbox || !env.dbPath.startsWith(sandbox)) {
        throw new Error(`resetDb refusing to delete ${env.dbPath}: test sandbox not active — run bun test from cli/ so bunfig's preload applies`);
    }

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
