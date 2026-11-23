/**
 * DB tests for artifact `file_id` storage: a later upsert that omits it keeps the stored one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { upsertArtifacts } from "../index.js";

let fx: { pool: Pool; drop: () => Promise<void> } | undefined;

afterEach(async () => {
    await fx?.drop();
    fx = undefined;
});

describe("artifact file_id", () => {
    it("COALESCE preserves file_id when a later upsert omits it", async () => {
        fx = await withSchema("input-fileid-coalesce");
        (
            await upsertArtifacts(fx.pool, [{ resourceId: "a-1", path: "data/inputs/x.csv", hash: "h1", size: 10, role: "input", fileId: "uuid-9" }])
        )._unsafeUnwrap();
        // Re-upsert (e.g. replay) without a fileId — must not clobber.
        (await upsertArtifacts(fx.pool, [{ resourceId: "a-1", path: "data/inputs/x.csv", hash: "h2", size: 20, role: "input" }]))._unsafeUnwrap();

        const rows = await fx.pool.query<{ file_id: string | null; hash: string }>(
            "SELECT file_id, hash FROM cortex_artifacts WHERE analysis_id = 'a-1' AND path = 'data/inputs/x.csv'",
        );
        expect(rows.rows).toEqual([{ file_id: "uuid-9", hash: "h2" }]);
    });
});
