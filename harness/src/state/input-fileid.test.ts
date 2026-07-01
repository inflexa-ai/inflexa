/**
 * DB tests for input-artifact `file_id` storage — the materialized fileId
 * that lets runtime provenance attribute data inputs by `fileId`.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { upsertArtifacts, queryInputArtifacts } from "./index.js";

let fx: { pool: Pool; drop: () => Promise<void> } | undefined;

afterEach(async () => {
    await fx?.drop();
    fx = undefined;
});

describe("input artifact file_id", () => {
    it("persists and reads back file_id on input rows", async () => {
        fx = await withSchema("input-fileid");
        await upsertArtifacts(fx.pool, [
            {
                resourceId: "a-1",
                path: "data/inputs/Lab/counts.csv",
                hash: "h1",
                size: 1000,
                role: "input",
                fileId: "uuid-1",
            },
        ]);

        const meta = await queryInputArtifacts(fx.pool, "a-1", ["data/inputs/Lab/counts.csv"]);
        expect(meta).toHaveLength(1);
        expect(meta[0]!.fileId).toBe("uuid-1");
    });

    it("COALESCE preserves file_id when a later upsert omits it", async () => {
        fx = await withSchema("input-fileid-coalesce");
        await upsertArtifacts(fx.pool, [{ resourceId: "a-1", path: "data/inputs/x.csv", hash: "h1", size: 10, role: "input", fileId: "uuid-9" }]);
        // Re-upsert (e.g. replay) without a fileId — must not clobber.
        await upsertArtifacts(fx.pool, [{ resourceId: "a-1", path: "data/inputs/x.csv", hash: "h2", size: 20, role: "input" }]);

        const meta = await queryInputArtifacts(fx.pool, "a-1", ["data/inputs/x.csv"]);
        expect(meta[0]!.fileId).toBe("uuid-9");
        expect(meta[0]!.hash).toBe("h2");
    });
});
