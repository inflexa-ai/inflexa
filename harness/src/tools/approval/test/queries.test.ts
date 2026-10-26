import { describe, expect, it } from "bun:test";

import { Pool } from "pg";

import { answerAsk } from "../queries.js";

/** A pool whose one client answers the guarded UPDATE with `updatedRows` and every other statement with an empty result. */
function poolAnsweringUpdateWith(updatedRows: Record<string, unknown>[]): Pool {
    const client = {
        query: (config: string | { text: string }) => {
            const text = typeof config === "string" ? config : config.text;
            if (text.startsWith("UPDATE cortex_asks")) return Promise.resolve({ rows: updatedRows, rowCount: updatedRows.length });
            return Promise.resolve({ rows: [], rowCount: 0 });
        },
        release: () => undefined,
    };
    // A real `Pool` whose `connect` the fake overrides; the own property wins at runtime, and a `Pool` that is never used opens no connection.
    return Object.assign(new Pool(), { connect: () => Promise.resolve(client) });
}

describe("answerAsk", () => {
    it("gives a DbError, not a rejection, when the updated grant row misses a field", async () => {
        const pool = poolAnsweringUpdateWith([{ analysis_id: "analysis-1", user_id: "user-1" }]);

        const result = await answerAsk(pool, "ask-1", { kind: "always" }, "2026-01-01T00:00:00.000Z");

        const error = result._unsafeUnwrapErr();
        expect(error.type).toBe("mutation_failed");
        expect(error.op).toBe("asks.answer:grant");
    });
});
