/**
 * Unit tests for the boot-time connection-budget guard (see the postgres-storage-backend spec).
 *
 * The guard is a per-pod self-check: one pod's pool footprint
 * (`app + dbos`) plus the safety margin must fit inside `max_connections`.
 * We mock the `pool.query` that reads `current_setting('max_connections')`
 * with synthetic values and exercise both the pass and fail paths.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { silentLogger } from "../__tests__/setup/logger.js";
import { assertConnectionBudget } from "./connection-budget.js";
import { DBOS_SYSTEM_POOL_SIZE, DEFAULT_APP_POOL_SIZE } from "./pools.js";

function fakePool(maxConnections: number): Pool {
    return {
        query: async () => ({
            rows: [{ max: String(maxConnections) }],
        }),
    } as unknown as Pool;
}

const originalEnv = { ...process.env };

beforeEach(() => {
    process.env.DB_PG_HOST = "localhost";
    process.env.DB_PG_NAME = "cortex";
    process.env.DB_PG_USER = "cortex";
    process.env.DB_PG_PASSWORD = "dev";
    process.env.NODE_ENV = "test";
    delete process.env.DB_POOL_MAX;
});

afterEach(() => {
    process.env = { ...originalEnv };
});

describe("assertConnectionBudget", () => {
    it("passes on defaults and reports replica headroom", async () => {
        // Footprint = 12 + 10 = 22. floor((100 − 5) / 22) = 4 supported replicas.
        const result = await assertConnectionBudget({
            pool: fakePool(100),
            logger: silentLogger,
            config: { poolMax: process.env.DB_POOL_MAX },
        });

        expect(result).toEqual({
            maxConnections: 100,
            appPoolSize: DEFAULT_APP_POOL_SIZE,
            dbosPoolSize: DBOS_SYSTEM_POOL_SIZE,
            podFootprint: 22,
            supportedReplicas: 4,
        });
    });

    it("honours a DB_POOL_MAX override and recomputes headroom", async () => {
        // Footprint = 40 + 10 = 50. floor((100 − 5) / 50) = 1 supported replica.
        process.env.DB_POOL_MAX = "40";

        const result = await assertConnectionBudget({
            pool: fakePool(100),
            logger: silentLogger,
            config: { poolMax: process.env.DB_POOL_MAX },
        });

        expect(result.appPoolSize).toBe(40);
        expect(result.podFootprint).toBe(50);
        expect(result.supportedReplicas).toBe(1);
    });

    it("passes the boundary where one footprint + margin equals max_connections", async () => {
        // Footprint = 22; 22 + 5 = 27 == 27.
        const result = await assertConnectionBudget({
            pool: fakePool(27),
            logger: silentLogger,
            config: { poolMax: process.env.DB_POOL_MAX },
        });

        expect(result.podFootprint).toBe(22);
        expect(result.supportedReplicas).toBe(1);
    });

    it("throws when a single pod's footprint cannot fit inside max_connections", async () => {
        // Footprint = 200 + 10 = 210; 210 + 5 > 100.
        process.env.DB_POOL_MAX = "200";

        await expect(
            assertConnectionBudget({
                pool: fakePool(100),
                logger: silentLogger,
                config: { poolMax: process.env.DB_POOL_MAX },
            }),
        ).rejects.toThrow(/FATAL: pg max_connections \(100\) cannot hold one pod's pool footprint \(210\)/);
    });
});
