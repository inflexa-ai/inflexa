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

import { DBOS, type DBOSConfig, type DLogger } from "@dbos-inc/dbos-sdk";
import type { Pool } from "pg";

import type { LogFields, Logger } from "../lib/logger.js";
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
     * Least severe SDK record forwarded to the host's `Logger` (winston level
     * names; the SDK's own default is `info`). The SDK's lines ride the
     * harness `Logger` seam under `[dbos.sdk]`, so this threshold is applied by
     * the bridge, not by the SDK. Interactive embedders pass `warn` so the
     * launch banner and migration chatter stay out of their logs; the server
     * root omits it and keeps the informative default.
     */
    readonly logLevel?: string;
    /**
     * Emit DBOS workflow and step spans on the globally registered
     * TracerProvider, and run every workflow and step body under an active
     * OTel context. Default `false`.
     *
     * DBOS installs nothing of its own here: with no OTLP endpoint of its own it
     * probes the global provider and, when one is registered, emits under the
     * instrumentation scope `dbos-tracer` through that provider's processors.
     * A host that registers no provider (the CLI passes a no-op
     * `initTelemetry`) must leave this off, otherwise the SDK installs its own
     * `BasicTracerProvider` and every span is created and never exported.
     *
     * Attribute names follow the `dbos.*` semantic-convention layout
     * (`otelAttributeFormat: "semconv"`).
     *
     * Known SDK behavior a host must plan for:
     * - a recovered workflow starts a new root trace, with no link to the trace
     *   of the original execution
     * - every already-completed step re-emits a `cached=true` span on replay,
     *   so a restart with many in-flight steps bursts spans; size
     *   `OTEL_BSP_MAX_QUEUE_SIZE` for it
     * - step span names embed the step, tool-use, or exec id
     */
    readonly tracingEnabled?: boolean;
}

/** DBOS lifecycle facts a host's readiness probe reports on. */
export interface DbosState {
    launched: boolean;
    recoveryStarted: boolean;
}

const state: DbosState = {
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

/** Winston severity ranks, ascending verbosity — the scale `DbosConfig.logLevel` names. */
const SDK_LOG_LEVEL_RANK: Readonly<Record<string, number>> = {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6,
};

const SDK_DEFAULT_LOG_LEVEL = "info";

/**
 * Bridge the SDK's internal logger onto the harness `Logger` seam, so the
 * SDK's own lines (`Recovering N workflows…`, migration chatter) land in the
 * host's sink instead of on the process console. The SDK does not filter by
 * `logLevel` before it delegates to a custom logger, so the threshold is
 * applied here. Records arrive as strings; an `Error` arrives as its message
 * with the stack (and cause chain) in `metadata.stack`; inside a workflow or
 * step body `metadata.span.attributes` carries the operation context, which
 * rides as fields.
 */
export function dbosSdkLogger(logger: Logger, logLevel: string | undefined): DLogger {
    const sink = logger.named("sdk");
    const threshold = SDK_LOG_LEVEL_RANK[logLevel ?? SDK_DEFAULT_LOG_LEVEL] ?? SDK_LOG_LEVEL_RANK[SDK_DEFAULT_LOG_LEVEL]!;
    const passes = (level: keyof typeof SDK_LOG_LEVEL_RANK): boolean => SDK_LOG_LEVEL_RANK[level]! <= threshold;
    const fields = (metadata: Parameters<DLogger["error"]>[1]): LogFields | undefined => {
        const attributes = metadata?.span?.attributes;
        const stack = metadata?.stack;
        if (attributes === undefined && stack === undefined) return undefined;
        return { ...attributes, ...(stack !== undefined ? { stack } : {}) };
    };
    const message = (entry: unknown): string => (typeof entry === "string" ? entry : String(entry));
    return {
        debug: (entry, metadata) => {
            if (passes("debug")) sink.debug(message(entry), fields(metadata));
        },
        info: (entry, metadata) => {
            if (passes("info")) sink.info(message(entry), fields(metadata));
        },
        warn: (entry, metadata) => {
            if (passes("warn")) sink.warn(message(entry), fields(metadata));
        },
        error: (entry, metadata) => {
            if (passes("error")) sink.error(message(entry), fields(metadata));
        },
    };
}

/**
 * The SDK config `launchDbos` sets. Pure over `DbosConfig`, so a test can
 * assert on the mapping without a launch.
 */
export function dbosSdkConfig(config: DbosConfig, logger: Logger): DBOSConfig {
    return {
        name: config.appName,
        systemDatabaseUrl: systemDatabaseUrl(config),
        systemDatabasePoolSize: DBOS_SYSTEM_POOL_SIZE,
        executorID: config.executorId,
        applicationVersion: config.applicationVersion,
        adminPort: parseInt(config.adminPort, 10),
        logLevel: config.logLevel,
        logger: dbosSdkLogger(logger, config.logLevel),
        tracingEnabled: config.tracingEnabled ?? false,
        otelAttributeFormat: "semconv",
    };
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
    const sdkConfig = dbosSdkConfig(config, logger);

    DBOS.setConfig(sdkConfig);

    const start = performance.now();
    await DBOS.launch();
    state.launched = true;
    state.recoveryStarted = true;
    logger.info("launched", {
        executorID: sdkConfig.executorID,
        applicationVersion: config.applicationVersion,
        adminPort: sdkConfig.adminPort,
        tracingEnabled: sdkConfig.tracingEnabled,
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
            ...logger.errorFields(err),
            durationMs: Math.round(performance.now() - start),
        });
    } finally {
        state.launched = false;
        state.recoveryStarted = false;
    }
}

/**
 * Cancel any legacy `ephemeral:`-prefixed PENDING workflow this executor owns
 * before `launchDbos`, whose recovery would otherwise re-dispatch rows created
 * by older releases. No current workflow creates this prefix. DBOS has no
 * "zero recovery" knob, and
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
            logger.info("swept legacy ephemeral workflow rows", { executorID, swept: rowCount });
        }
    } catch (err) {
        // First-ever boot: DBOS has not created its schema yet — nothing to sweep.
        if (err && typeof err === "object" && "code" in err && err.code === "42P01") {
            return;
        }
        logger.error("legacy ephemeral-row sweep failed", { executorID, ...logger.errorFields(err) });
    }
}

/** Snapshot of DBOS lifecycle state — read by the readiness probe. */
export function dbosState(): DbosState {
    return { ...state };
}

/** Test hook: force-reset state without calling DBOS. Test-only. */
export function __resetDbosStateForTest(): void {
    state.launched = false;
    state.recoveryStarted = false;
}

/** Test hook: mark launched without calling DBOS. Test-only. */
export function __setDbosStateForTest(next: Partial<DbosState>): void {
    if (next.launched !== undefined) state.launched = next.launched;
    if (next.recoveryStarted !== undefined) state.recoveryStarted = next.recoveryStarted;
}
