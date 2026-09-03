/**
 * Unit tests for the DBOS bootstrap module. The actual DBOS engine is not
 * launched — these tests cover idempotence, state reporting, shutdown, and
 * the legacy pre-recovery migration sweep.
 *
 * End-to-end "launch a real DBOS against a testcontainer" coverage lives
 * with the durable workflow tests (change 8).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Pool } from "pg";

import { createCapturingLogger, silentLogger } from "../__tests__/setup/logger.js";
import { __resetDbosStateForTest, __setDbosStateForTest, dbosSdkConfig, dbosSdkLogger, dbosState, sweepEphemeralWorkflows, type DbosConfig } from "./dbos.js";

const stubConfig = {} as DbosConfig;

const fullConfig: DbosConfig = {
    dbHost: "db.internal",
    dbPort: "5432",
    dbName: "cortex",
    dbUser: "cortex",
    dbPassword: "secret",
    dbSslMode: "disable",
    appName: "cortex",
    adminPort: "3001",
    executorId: "pod-1",
};

/**
 * `DBOS.shutdown` is stubbed by DIRECT property assignment, which
 * `mock.restore()` does NOT undo — capture the original and put it back in
 * `afterAll` so later test files (the registration-window bounce in the
 * DBOS integration files, the rig's exit hook) call the real shutdown.
 */
let originalShutdown: unknown;

beforeEach(() => {
    __resetDbosStateForTest();
});

afterEach(() => {
    mock.restore();
});

afterAll(async () => {
    if (originalShutdown === undefined) return;
    const dbos = await import("@dbos-inc/dbos-sdk");
    (dbos.DBOS.shutdown as unknown) = originalShutdown;
});

describe("dbosState", () => {
    it("reports not-launched by default", () => {
        expect(dbosState()).toEqual({
            launched: false,
            recoveryStarted: false,
        });
    });

    it("reflects test-state overrides", () => {
        __setDbosStateForTest({ launched: true, recoveryStarted: true });
        expect(dbosState()).toEqual({
            launched: true,
            recoveryStarted: true,
        });
    });

    it("returns a fresh snapshot — caller cannot mutate internal state", () => {
        __setDbosStateForTest({ launched: true, recoveryStarted: true });
        const snap = dbosState();
        snap.launched = false;
        expect(dbosState().launched).toBe(true);
    });
});

describe("launchDbos / shutdownDbos", () => {
    it("launchDbos is idempotent when state already says launched", async () => {
        // Pre-flag launched — the real `DBOS.launch()` is not called, proving
        // the idempotent guard short-circuits before reaching the SDK.
        __setDbosStateForTest({ launched: true, recoveryStarted: true });
        const { launchDbos } = await import("./dbos.js");
        await launchDbos({ config: stubConfig, logger: silentLogger });
        expect(dbosState().launched).toBe(true);
    });

    it("shutdownDbos is a no-op when DBOS was never launched", async () => {
        const { shutdownDbos } = await import("./dbos.js");
        await shutdownDbos({ logger: silentLogger });
        expect(dbosState().launched).toBe(false);
    });

    it("shutdownDbos swallows errors and resets state", async () => {
        __setDbosStateForTest({ launched: true, recoveryStarted: true });
        const dbos = await import("@dbos-inc/dbos-sdk");
        originalShutdown ??= dbos.DBOS.shutdown;
        const stub = mock(() => Promise.reject(new Error("boom")));
        (dbos.DBOS.shutdown as unknown) = stub;

        const { shutdownDbos } = await import("./dbos.js");
        // Must not throw — the wider shutdown sequence depends on this.
        await shutdownDbos({ logger: silentLogger });
        expect(dbosState().launched).toBe(false);
        expect(stub).toHaveBeenCalled();
    });
});

describe("dbosSdkConfig", () => {
    it("leaves SDK tracing off unless the host turns it on", () => {
        const sdk = dbosSdkConfig(fullConfig, silentLogger);
        expect(sdk.tracingEnabled).toBe(false);
        expect(sdk.otelAttributeFormat).toBe("semconv");
        expect(sdk.enableOTLP).toBeUndefined();
        expect(sdk.otlpTracesEndpoints).toBeUndefined();
    });

    it("passes tracingEnabled through", () => {
        expect(dbosSdkConfig({ ...fullConfig, tracingEnabled: true }, silentLogger).tracingEnabled).toBe(true);
    });

    it("routes the SDK's own logging through the harness Logger seam", () => {
        const logger = createCapturingLogger();
        const sdk = dbosSdkConfig(fullConfig, logger);
        sdk.logger!.info("Recovering 2 workflows");
        expect(logger.records).toEqual([{ level: "info", msg: "[sdk] Recovering 2 workflows", fields: {} }]);
    });
});

describe("dbosSdkLogger", () => {
    it("applies the configured threshold, since the SDK does not filter a custom logger", () => {
        const logger = createCapturingLogger();
        const sdk = dbosSdkLogger(logger, "warn");
        sdk.debug("d");
        sdk.info("i");
        sdk.warn("w");
        sdk.error("e");
        expect(logger.records.map((r) => r.level)).toEqual(["warn", "error"]);
    });

    it("defaults the threshold to info", () => {
        const logger = createCapturingLogger();
        const sdk = dbosSdkLogger(logger, undefined);
        sdk.debug("d");
        sdk.info("i");
        expect(logger.records.map((r) => r.level)).toEqual(["info"]);
    });

    it("carries the stack and the operation context as fields, not in the message", () => {
        const logger = createCapturingLogger();
        const sdk = dbosSdkLogger(logger, "info");
        const span = { attributes: { "dbos.operation.workflow_id": "wf-1", "dbos.operation.name": "executeAnalysis" } };
        sdk.error("step failed", { stack: "Error: step failed\n    at x", span: span as never });
        expect(logger.records).toHaveLength(1);
        expect(logger.records[0]!.msg).toBe("[sdk] step failed");
        expect(logger.records[0]!.fields).toEqual({
            "dbos.operation.workflow_id": "wf-1",
            "dbos.operation.name": "executeAnalysis",
            stack: "Error: step failed\n    at x",
        });
    });
});

describe("legacy ephemeral workflow migration sweep", () => {
    it("cancels only pending rows for the current executor before recovery", async () => {
        const queries: Array<{ text: string; values?: unknown[] }> = [];
        const pool = {
            query: async (query: { text: string; values?: unknown[] }) => {
                queries.push(query);
                return { rows: [], rowCount: 2 };
            },
        } as unknown as Pool;

        await sweepEphemeralWorkflows({ pool, logger: silentLogger, executorId: "executor-1" });

        expect(queries).toHaveLength(1);
        expect(queries[0]!.text).toContain("status = 'PENDING'");
        expect(queries[0]!.text).toContain("executor_id = $2");
        expect(queries[0]!.text).toContain("workflow_uuid LIKE 'ephemeral:%'");
        expect(queries[0]!.values?.[1]).toBe("executor-1");
    });
});
