/**
 * DBOS Transact bootstrap.
 *
 * This is the only module that imports `@dbos-inc/dbos-sdk` directly. The
 * agent loop and routes depend on the `RunStep` shape (`harness/loop/types.ts`),
 * so DBOS stays swappable and the chat path never reaches into the workflow
 * runtime. `harness/loop/run-step.ts` wraps `DBOS.runStep` for the durable
 * variant; nothing else here.
 *
 * Launch is dormant — this change registers no workflows. The durability seam
 * exists; the engine is running; nothing is durable yet.
 *
 * See `openspec/changes/harness-dbos-runtime`.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import type { Logger } from "../lib/logger.js";
import { DBOS_SYSTEM_POOL_SIZE } from "./pools.js";

/**
 * Narrow config slice the DBOS bootstrap reads. Composition roots map their
 * validated `Env` onto this and pass the executor id in (the harness reads no env).
 */
export interface DbosConfig {
    readonly dbHost: string;
    readonly dbPort: string;
    readonly dbName: string;
    readonly dbUser: string;
    readonly dbPassword: string;
    readonly dbSslMode: "disable" | "require" | "verify-ca" | "verify-full";
    readonly appName: string;
    readonly applicationVersion?: string;
    readonly adminPort: string;
    /** Stable per-pod executor id (e.g. `process.env.HOSTNAME ?? "local-dev"`). */
    readonly executorId: string;
    /**
     * SDK log verbosity (winston levels; the SDK's own default is `info`).
     * Interactive embedders pass `warn` so the launch banner and migration
     * chatter don't interleave with their own command output; the server root
     * omits it and keeps the informative default.
     */
    readonly logLevel?: string;
}

interface State {
    launched: boolean;
    recoveryStarted: boolean;
}

const state: State = {
    launched: false,
    recoveryStarted: false,
};

/**
 * Build the Postgres URL DBOS uses for its system database. Reuses the
 * existing `DB_PG_*` env vars; sslmode is propagated as a query string so
 * DBOS's underlying `pg.Pool` honours it.
 *
 * The sslmode must mirror the app pool's mapping in `lib/storage.ts`:
 * `require` means "encrypt, don't verify the chain" there, but
 * `pg-connection-string` parses bare `require` as an alias for `verify-full`
 * (full chain verification). Against RDS — whose CA isn't in Node's default
 * trust store — that fails with SELF_SIGNED_CERT_IN_CHAIN. Emit `no-verify`
 * so DBOS's pool gets `rejectUnauthorized: false`, matching the app pool.
 */
function dbosSslMode(mode: DbosConfig["dbSslMode"]): string {
    if (mode === "disable") return "disable";
    if (mode === "verify-ca" || mode === "verify-full") return "verify-full";
    return "no-verify";
}

function systemDatabaseUrl(config: DbosConfig): string {
    const user = encodeURIComponent(config.dbUser);
    const password = encodeURIComponent(config.dbPassword);
    const host = config.dbHost;
    const port = config.dbPort;
    const database = encodeURIComponent(config.dbName);
    return `postgresql://${user}:${password}@${host}:${port}/${database}?sslmode=${dbosSslMode(config.dbSslMode)}`;
}

/**
 * Launch DBOS. Idempotent — a second call is a no-op so tests that drive
 * the harness twice (or accidentally double-import) don't re-launch.
 *
 * Order is load-bearing: `setConfig` must precede `launch`, and `launch`
 * must resolve before the HTTP listener accepts traffic (otherwise the
 * readiness probe could 200 against a runtime that can't own workflows).
 */
export async function launchDbos({ config, logger: injected }: { config: DbosConfig; logger: Logger }): Promise<void> {
    if (state.launched) return;

    const logger = injected.named("dbos");
    const executorID = config.executorId;
    const adminPort = parseInt(config.adminPort, 10);

    DBOS.setConfig({
        name: config.appName,
        systemDatabaseUrl: systemDatabaseUrl(config),
        systemDatabasePoolSize: DBOS_SYSTEM_POOL_SIZE,
        executorID,
        applicationVersion: config.applicationVersion,
        adminPort,
        logLevel: config.logLevel,
    });

    const start = performance.now();
    await DBOS.launch();
    state.launched = true;
    state.recoveryStarted = true;
    logger.info("launched", {
        executorID,
        applicationVersion: config.applicationVersion,
        adminPort,
        durationMs: Math.round(performance.now() - start),
    });
}

/**
 * Shut DBOS down. In-flight workflows are marked recoverable so another
 * replica (or this pod on restart) can adopt them. Never throws — the
 * outer shutdown sequence must close the pg.Pool and flush exporters even
 * if DBOS shutdown fails.
 *
 * Must run after HTTP has drained (so no inbound request is orphaned) and
 * before the application pool closes (DBOS needs the system DB).
 */
export async function shutdownDbos({ logger: injected }: { logger: Logger }): Promise<void> {
    if (!state.launched) return;
    const logger = injected.named("dbos");
    const start = performance.now();
    try {
        await DBOS.shutdown();
        logger.info("shutdown", { durationMs: Math.round(performance.now() - start) });
    } catch (err) {
        logger.error("shutdown failed", {
            err: err instanceof Error ? err.message : String(err),
            durationMs: Math.round(performance.now() - start),
        });
    } finally {
        state.launched = false;
        state.recoveryStarted = false;
    }
}

/**
 * Cancel any `ephemeral:`-prefixed PENDING workflow this executor owns —
 * called BEFORE `launchDbos`, whose recovery would otherwise re-dispatch them.
 *
 * Ephemeral runs are turn-scoped: a run whose pod died mid-flight has no live
 * awaiter and must never re-execute. DBOS has no "zero recovery" knob, and
 * `launch()` starts recovery itself, so there is no post-launch window to
 * cancel from — the only race-free point is a direct system-DB UPDATE before
 * launch. A CANCELLED row is excluded from the recovery query (which selects
 * `status='PENDING'`). The `dbos.workflow_status` coupling is the price of
 * pre-launch timing, and this is the sole module that owns DBOS. The system
 * DB is the same database as the app pool, so the pool reaches it directly.
 */
export async function sweepEphemeralWorkflows({
    pool,
    logger: injectedLogger,
    executorId,
}: {
    pool: Pool;
    logger: Logger;
    /** Stable per-pod executor id — must match `launchDbos`'s `executorId`. */
    executorId: string;
}): Promise<void> {
    const logger = injectedLogger.named("dbos");
    const executorID = executorId;
    try {
        const { rowCount } = await pool.query({
            text: `UPDATE dbos.workflow_status
                SET status = 'CANCELLED', updated_at = $1
              WHERE status = 'PENDING'
                AND executor_id = $2
                AND workflow_uuid LIKE 'ephemeral:%'`,
            values: [Date.now(), executorID],
        });
        if (rowCount && rowCount > 0) {
            logger.info("swept orphaned ephemeral workflows", { executorID, swept: rowCount });
        }
    } catch (err) {
        // First-ever boot: DBOS has not created its schema yet — nothing to sweep.
        if (err && typeof err === "object" && "code" in err && err.code === "42P01") {
            return;
        }
        logger.error("ephemeral sweep failed", { executorID, err: err instanceof Error ? err.message : String(err) });
    }
}

/** Snapshot of DBOS lifecycle state — read by the readiness probe. */
export function dbosState(): State {
    return { ...state };
}

/** Test hook: force-reset state without calling DBOS. Test-only. */
export function __resetDbosStateForTest(): void {
    state.launched = false;
    state.recoveryStarted = false;
}

/** Test hook: mark launched without calling DBOS. Test-only. */
export function __setDbosStateForTest(next: Partial<State>): void {
    if (next.launched !== undefined) state.launched = next.launched;
    if (next.recoveryStarted !== undefined) state.recoveryStarted = next.recoveryStarted;
}
