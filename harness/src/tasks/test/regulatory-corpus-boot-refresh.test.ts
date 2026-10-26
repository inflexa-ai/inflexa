import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { maybeKickOffRegulatoryCorpusRefresh, type BootRefreshDeps } from "../regulatory-corpus-boot-refresh.js";

const silentLog: NonNullable<BootRefreshDeps["log"]> = {
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

const embedder = (): Promise<number[]> => Promise.resolve([]);

let pool: Pool;
let drop: () => Promise<void>;

beforeAll(async () => {
    const ctx = await withSchema("regulatory_boot_refresh");
    pool = ctx.pool;
    drop = ctx.drop;
});

afterAll(async () => {
    await drop();
});

beforeEach(async () => {
    await pool.query("DELETE FROM cortex_regulatory_chunks");
});

async function seedChunk(indexedAtSql: string): Promise<void> {
    await pool.query(
        `INSERT INTO cortex_regulatory_chunks (source, doc_id, doc_title, doc_url, chunk_index, chunk_text, indexed_at)
         VALUES ('FDA-CDER', 'doc-1', 'A guidance', 'https://example.invalid/g', 0, 'text', ${indexedAtSql})`,
    );
}

describe("maybeKickOffRegulatoryCorpusRefresh", () => {
    it("skips the refresh when the newest chunk is fresh", async () => {
        await seedChunk("NOW()");

        const outcome = await maybeKickOffRegulatoryCorpusRefresh({
            pool,
            embedder,
            log: silentLog,
            refresh: () => Promise.reject(new Error("a fresh corpus must not refresh")),
        });

        expect(outcome).toBe("skipped-fresh");
    });

    it("starts the refresh when the newest chunk is older than the interval", async () => {
        await seedChunk("NOW() - INTERVAL '120 days'");
        const refreshed = Promise.withResolvers<undefined>();

        const outcome = await maybeKickOffRegulatoryCorpusRefresh({
            pool,
            embedder,
            log: silentLog,
            refresh: () => {
                refreshed.resolve(undefined);
                return Promise.resolve({ ok: 0, fail: 0 });
            },
        });
        await refreshed.promise;

        expect(outcome).toBe("started");
    });
});
