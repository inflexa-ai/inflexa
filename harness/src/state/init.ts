/**
 * Cortex state table initialization.
 *
 * The schema of the `cortex_*` tables is a list of versioned migrations
 * (`./migrations`), which the Kysely migrator applies. It records each applied
 * migration in `cortex_migration`, and it serializes concurrent runs with a
 * Postgres advisory lock. A run with no pending migration runs no DDL, thus it
 * takes no lock on a Cortex table.
 */

import { Kysely, PostgresDialect, sql } from "kysely";
import { Migrator, type Migration } from "kysely/migration";
import type { Pool } from "pg";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import { cortexMigrations } from "./migrations/index.js";

/**
 * The longest time that a migration statement waits for a lock. An `ALTER TABLE`
 * that waits in the lock queue holds up each later query on its table, the
 * queries of the live replicas included. Thus a migration that meets a long
 * transaction fails at this bound, and the host runs it again.
 */
const MIGRATION_LOCK_TIMEOUT_MS = 5_000;

/**
 * Apply the pending migrations of the Cortex state tables. Safe to call on every
 * startup and across concurrent replicas.
 */
export async function initCortexState(pool: Pool, injected?: Logger): Promise<void> {
    const logger = (injected ?? createNoopLogger()).named("cortex-state");
    const { rows } = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");
    const db = new Kysely<unknown>({
        // `destroy` ends the pool of the dialect, and this pool belongs to the caller.
        dialect: new PostgresDialect({ pool: { connect: () => pool.connect(), end: () => Promise.resolve(), options: pool.options } }),
    });
    try {
        const migrator = new Migrator({
            db,
            provider: { getMigrations: () => Promise.resolve(withLockTimeout(cortexMigrations(logger))) },
            migrationTableName: "cortex_migration",
            migrationLockTableName: "cortex_migration_lock",
            // Without a schema, the migrator finds its tables in any schema, thus a
            // test schema would see the tables of the other test schemas.
            migrationTableSchema: rows[0]!.schema,
        });
        const { error, results } = await migrator.migrateToLatest();
        for (const result of results ?? []) {
            if (result.status === "Success") logger.info("migration applied", { migration: result.migrationName });
        }
        if (error !== undefined) {
            throw error instanceof Error ? error : new Error(`cortex state migration failed: ${String(error)}`);
        }
    } finally {
        await db.destroy();
    }
}

/** The migrator runs the migrations in one transaction, thus the setting lasts until the commit. */
function withLockTimeout(migrations: Record<string, Migration>): Record<string, Migration> {
    const wrapped: Record<string, Migration> = {};
    for (const [name, migration] of Object.entries(migrations)) {
        wrapped[name] = {
            async up(db) {
                await sql`SELECT set_config('lock_timeout', ${`${MIGRATION_LOCK_TIMEOUT_MS}ms`}, true)`.execute(db);
                await migration.up(db);
            },
        };
    }
    return wrapped;
}
