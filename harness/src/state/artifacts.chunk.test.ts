import { describe, expect, it } from "bun:test";

import type { Querier } from "./db.js";
import { upsertArtifacts, type RegisterArtifactInput } from "./artifacts.js";

/**
 * The Postgres extended protocol's Bind message carries the parameter count
 * as an Int16 — one statement may never carry more than 65,535 bind values.
 * These tests pin the chunking that keeps `upsertArtifacts` under that cap
 * for unbounded manifests (a data-profile over a large directory input);
 * a fake Querier captures statements, so no database is needed.
 */

type Captured = { text: string; values: unknown[] };

function capturingQuerier(): { querier: Querier; captured: Captured[] } {
    const captured: Captured[] = [];
    const fake = {
        query: async (q: Captured) => {
            captured.push(q);
            return { rows: [], rowCount: 0 };
        },
    };
    // The functions under test only ever call `.query`; the cast narrows the
    // fake to the Pool|PoolClient union without dragging in a live pool.
    return { querier: fake as unknown as Querier, captured };
}

function entry(i: number): RegisterArtifactInput {
    return {
        resourceId: "an-1",
        path: `data/inputs/local/f${i}.csv`,
        hash: `hash-${i}`,
        size: i,
        role: "input",
        fileId: `file-${i}`,
    };
}

const WIRE_PARAM_LIMIT = 65_535;

describe("upsertArtifacts chunking", () => {
    it("keeps every statement under the wire-protocol parameter cap for huge manifests", async () => {
        const { querier, captured } = capturingQuerier();
        const entries = Array.from({ length: 7_000 }, (_, i) => entry(i));

        await upsertArtifacts(querier, entries);

        expect(captured.length).toBeGreaterThan(1);
        for (const q of captured) {
            expect(q.values.length).toBeLessThanOrEqual(WIRE_PARAM_LIMIT);
        }
        // Every row survives, in order, across the chunk boundary.
        const paths = captured.flatMap((q) => q.values.filter((_, idx) => idx % 10 === 1));
        expect(paths).toHaveLength(7_000);
        expect(paths[0]).toBe("data/inputs/local/f0.csv");
        expect(paths[6_999]).toBe("data/inputs/local/f6999.csv");
    });

    it("placeholders restart at $1 in every statement", async () => {
        const { querier, captured } = capturingQuerier();
        await upsertArtifacts(
            querier,
            Array.from({ length: 1_500 }, (_, i) => entry(i)),
        );

        expect(captured).toHaveLength(2);
        for (const q of captured) {
            expect(q.text).toContain("($1, $2, $3");
            // The highest placeholder must match the statement's own value count.
            const max = Math.max(...[...q.text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
            expect(max).toBe(q.values.length);
        }
    });

    it("a small manifest stays a single statement and an empty one issues none", async () => {
        const one = capturingQuerier();
        await upsertArtifacts(one.querier, [entry(0), entry(1)]);
        expect(one.captured).toHaveLength(1);

        const none = capturingQuerier();
        await upsertArtifacts(none.querier, []);
        expect(none.captured).toHaveLength(0);
    });
});
