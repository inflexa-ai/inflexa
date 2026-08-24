/**
 * The store's delete surface, which is what makes the profile index a projection rather
 * than an accumulation. Asserted against a real table: the point is which rows survive.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import { createVectorStore } from "./vector-store.js";

const INDEX = "search_vector_store_delete";
const DIMENSION = 3;

describe("deleteByType", () => {
    let pool: Pool;
    let drop: () => Promise<void>;

    beforeEach(async () => {
        const ctx = await withSchema("vector_store_delete");
        pool = ctx.pool;
        drop = ctx.drop;
        const store = createVectorStore(pool);
        (await store.createIndex({ indexName: INDEX, dimension: DIMENSION }))._unsafeUnwrap();
        (
            await store.upsert({
                indexName: INDEX,
                ids: ["/a/group/calls", "/a/dimension/subject", "/a/data/inputs/sheet.csv", "/a/runs/r1/s1/output/plot.png", "/a/runs/r1/s1/summary"],
                vectors: [
                    [1, 0, 0],
                    [0, 1, 0],
                    [0, 0, 1],
                    [1, 1, 0],
                    [1, 0, 1],
                ],
                metadata: [{ type: "input-group" }, { type: "input-dimension" }, { type: "input" }, { type: "output" }, { type: "summary" }],
            })
        )._unsafeUnwrap();
    });

    afterEach(async () => {
        await drop();
    });

    async function remainingIds(): Promise<string[]> {
        const rows = await pool.query<{ vector_id: string }>(`SELECT vector_id FROM "${INDEX}" ORDER BY vector_id`);
        return rows.rows.map((row) => row.vector_id);
    }

    it("removes every entry of the named types and leaves the rest", async () => {
        (await createVectorStore(pool).deleteByType({ indexName: INDEX, types: ["input-group", "input-dimension", "input", "input-kind"] }))._unsafeUnwrap();

        expect(await remainingIds()).toEqual(["/a/runs/r1/s1/output/plot.png", "/a/runs/r1/s1/summary"]);
    });

    it("removes nothing when no type is named", async () => {
        (await createVectorStore(pool).deleteByType({ indexName: INDEX, types: [] }))._unsafeUnwrap();

        expect(await remainingIds()).toHaveLength(5);
    });

    it("leaves a renamed group's stale entry gone rather than beside its replacement", async () => {
        const store = createVectorStore(pool);
        (await store.deleteByType({ indexName: INDEX, types: ["input-group"] }))._unsafeUnwrap();
        (
            await store.upsert({
                indexName: INDEX,
                ids: ["/a/group/per-subject-calls"],
                vectors: [[1, 0, 0]],
                metadata: [{ type: "input-group" }],
            })
        )._unsafeUnwrap();

        const ids = await remainingIds();
        expect(ids).toContain("/a/group/per-subject-calls");
        expect(ids).not.toContain("/a/group/calls");
    });

    it("refuses an index name it did not derive", () => {
        expect(() => createVectorStore(pool).deleteByType({ indexName: 'search_a"; DROP TABLE x; --', types: ["input"] })).toThrow("unsafe index name");
    });
});
