/**
 * Tests for the application pool's bounded connection acquisition (see the
 * postgres-storage-backend spec).
 *
 * Two halves of one guarantee: `createPool` carries a finite acquisition bound,
 * and a saturated pool honouring such a bound rejects rather than waiting for a
 * client that may never come back. The saturation half runs against a real
 * Postgres with a deliberately tiny bound — the shipped 30s value is sized for
 * production burst, not for a test's patience.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import pg, { type Pool } from "pg";

import { getTestPool } from "../__tests__/setup/postgres.js";
import { APP_POOL_ACQUIRE_TIMEOUT_MS } from "../runtime/pools.js";
import { createPool } from "./storage.js";

/** Stand-in for the shipped bound, small enough that the test finishes fast. */
const TEST_ACQUIRE_TIMEOUT_MS = 1_000;

describe("createPool", () => {
    it("bounds connection acquisition", async () => {
        const pool = createPool({
            host: "127.0.0.1",
            port: "5432",
            database: "cortex",
            user: "cortex",
            password: "cortex",
            sslMode: "disable",
        });

        try {
            expect(pool.options.connectionTimeoutMillis).toBe(APP_POOL_ACQUIRE_TIMEOUT_MS);
        } finally {
            await pool.end();
        }
    });
});

describe("app pool acquisition under saturation", () => {
    let pool: Pool;

    beforeAll(async () => {
        const base = await getTestPool();
        const { host, port, user, password, database, connectionString } = base.options;
        pool = new pg.Pool({
            host,
            port,
            user,
            password,
            database,
            connectionString,
            max: 1,
            connectionTimeoutMillis: TEST_ACQUIRE_TIMEOUT_MS,
        });
    });

    afterAll(async () => {
        await pool.end();
    });

    it(
        "rejects a further acquisition instead of waiting for the held client",
        async () => {
            const held = await pool.connect();
            try {
                expect(pool.totalCount).toBe(1);
                await expect(pool.connect()).rejects.toThrow(/timeout/i);
            } finally {
                held.release();
            }

            // The bound is a failure mode, not a broken pool: once the client is
            // back, the next acquisition succeeds.
            const after = await pool.connect();
            after.release();
        },
        TEST_ACQUIRE_TIMEOUT_MS * 15,
    );
});
