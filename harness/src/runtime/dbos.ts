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
import { metrics } from "@opentelemetry/api";
import type { Pool, QueryResult } from "pg";

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
     * The harness TracerProvider shapes what the SDK emits (`lib/otel-spans.ts`):
     * a workflow declared with `untracedWorkflow` is not recorded, a replayed
     * `cached=true` span is dropped before export, and a step body that calls
     * `stableSpan` is exported under a stable name with its id in an
     * `inflexa.*` attribute. The step name DBOS records is unchanged.
     *
     * Known SDK behavior a host must plan for: a recovered workflow starts a
     * new root trace, with no link to the trace of the original execution.
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

/**
 * Age at which a PENDING or ENQUEUED workflow counts as stale: 6 h.
 *
 * The longest-lived healthy workflow is the parent of an analysis run, which
 * stays PENDING for the whole run, and `cortex.run.duration` puts its last
 * finite bucket at 4 h. Six hours clears that bound with margin, so the count
 * holds only a workflow that no process drives to an end: an orphan of an
 * executor that is gone, or a body blocked on a message that never arrives. A
 * workflow that crash-loops is the task of the recovery-attempts gauge, which
 * does not wait for age.
 */
export const STALE_WORKFLOW_AGE_MS = 6 * 60 * 60 * 1000;

/** Server-side cap on the health query, which reads a partial index and takes about a millisecond. */
const WORKFLOW_HEALTH_STATEMENT_TIMEOUT_MS = 2_000;

/**
 * Client-side cap on one observation, the wait for a pool connection included.
 * It sits well inside the 30 s export timeout, so a saturated app pool costs
 * this gauge one sample and never costs the other instruments their export.
 */
const WORKFLOW_HEALTH_OBSERVE_TIMEOUT_MS = 5_000;

/** The non-terminal DBOS statuses, less DELAYED, which waits for its start time by design. */
const NON_TERMINAL_STATUSES = ["PENDING", "ENQUEUED"] as const;
type NonTerminalStatus = (typeof NON_TERMINAL_STATUSES)[number];

/**
 * One grouped read of the non-terminal rows. `SET LOCAL` and the SELECT share
 * the implicit transaction of one simple-protocol message (no bind values), so
 * the timeout covers the SELECT and lapses with it on success or on error; the
 * pooled connection keeps its own setting. `status IN (...)` matches the DBOS
 * partial index `idx_workflow_status_in_flight`, so the cost follows the
 * in-flight rows and not the table. `created_at` is epoch milliseconds, read
 * against the database clock.
 */
const WORKFLOW_HEALTH_QUERY = `SET LOCAL statement_timeout = ${WORKFLOW_HEALTH_STATEMENT_TIMEOUT_MS};
SELECT status,
       count(*) FILTER (WHERE created_at < (extract(epoch FROM now()) * 1000)::bigint - ${STALE_WORKFLOW_AGE_MS}) AS stale,
       max(recovery_attempts) AS max_recovery_attempts
  FROM dbos.workflow_status
 WHERE status IN ('PENDING', 'ENQUEUED')
 GROUP BY status`;

/** One row of the health query. `pg` returns a bigint as a string. */
interface WorkflowHealthRow {
    readonly status: NonTerminalStatus;
    readonly stale: string;
    readonly max_recovery_attempts: string | null;
}

async function queryWorkflowHealth(pool: Pool): Promise<readonly WorkflowHealthRow[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`workflow health query exceeded ${WORKFLOW_HEALTH_OBSERVE_TIMEOUT_MS} ms`)),
            WORKFLOW_HEALTH_OBSERVE_TIMEOUT_MS,
        );
    });
    try {
        // A message of two statements answers with one result for each; the SELECT is the last.
        const results = (await Promise.race([pool.query(WORKFLOW_HEALTH_QUERY), deadline])) as unknown as readonly QueryResult<WorkflowHealthRow>[];
        return results.at(-1)?.rows ?? [];
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Observe the stuck-workflow gauges on `dbos.workflow_status`, once for each
 * metric export:
 *
 *   - cortex.dbos.workflows.stale{status}          — PENDING and ENQUEUED workflows created more than `STALE_WORKFLOW_AGE_MS` ago
 *   - cortex.dbos.workflows.recovery_attempts.max  — the highest `recovery_attempts` over PENDING and ENQUEUED workflows of any age
 *
 * DBOS increments `recovery_attempts` each time it starts a workflow, so a
 * workflow that ran once reads 1, and one that every boot recovers climbs
 * toward the SDK ceiling of 100.
 *
 * The table is fleet-wide, thus each replica reports the same values: an
 * alert aggregates with `max`, never `sum`.
 *
 * `status` is the only label. The cumulative export repeats the last value of
 * an attribute set that a collection does not observe, so every label set is
 * observed each time, zero included. The workflow names are spread over the
 * registrations of the harness and of the embedder, thus a name label could
 * not be observed at zero and a cleared count would never fall. The id of a
 * stuck workflow comes from the table itself.
 *
 * The gauges bind to the global meter, as every harness instrument does. With
 * metric export off, or under a host that registers no MeterProvider (the
 * CLI), that is the API no-op meter, which never calls the callback, thus no
 * query runs. The callback also skips the query while DBOS is not launched:
 * before launch the schema can be absent, and at shutdown the pool closes
 * before the last export. A failed query logs a warning and observes nothing,
 * so the export repeats the last values.
 */
export function observeDbosWorkflows({ pool, logger: injected }: { pool: Pool; logger: Logger }): void {
    const logger = injected.named("dbos");
    const meter = metrics.getMeter("cortex.dbos");
    const stale = meter.createObservableGauge("cortex.dbos.workflows.stale", {
        description: `PENDING or ENQUEUED DBOS workflows created more than ${STALE_WORKFLOW_AGE_MS / 3_600_000} h ago. Tagged by status.`,
        unit: "{workflow}",
    });
    const recoveryAttempts = meter.createObservableGauge("cortex.dbos.workflows.recovery_attempts.max", {
        description: "Highest recovery_attempts over PENDING and ENQUEUED DBOS workflows. A workflow that ran once reads 1.",
        unit: "{attempt}",
    });
    meter.addBatchObservableCallback(
        async (observer) => {
            if (!state.launched) return;
            let rows: readonly WorkflowHealthRow[];
            try {
                rows = await queryWorkflowHealth(pool);
            } catch (err) {
                logger.warn("workflow health query failed", logger.errorFields(err));
                return;
            }
            const staleByStatus: Record<NonTerminalStatus, number> = { PENDING: 0, ENQUEUED: 0 };
            let maxAttempts = 0;
            for (const row of rows) {
                staleByStatus[row.status] = Number(row.stale);
                maxAttempts = Math.max(maxAttempts, Number(row.max_recovery_attempts ?? 0));
            }
            for (const status of NON_TERMINAL_STATUSES) observer.observe(stale, staleByStatus[status], { status });
            observer.observe(recoveryAttempts, maxAttempts);
        },
        [stale, recoveryAttempts],
    );
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
