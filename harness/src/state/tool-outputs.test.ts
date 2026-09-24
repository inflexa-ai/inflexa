import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import type { KeptToolOutput, ToolOutputStore } from "../loop/tool-output.js";
import { createToolOutputStore } from "./tool-outputs.js";

function kept(overrides: Partial<KeptToolOutput> & Pick<KeptToolOutput, "ref">): KeptToolOutput {
    return { analysisId: "analysis-a", toolName: "read_file", toolCallId: "toolu_01", content: "text", totalLength: 4, ...overrides };
}

describe("createToolOutputStore", () => {
    let pool: Pool;
    let drop: () => Promise<void>;
    let store: ToolOutputStore;

    beforeAll(async () => {
        ({ pool, drop } = await withSchema("tool_outputs"));
        store = createToolOutputStore(pool);
    });

    afterAll(async () => {
        await drop();
    });

    it("gives back a text of 300,000 characters with characters outside ASCII, byte-identical", async () => {
        const content = `${"a".repeat(299_997)}é😀`;
        const record = kept({ ref: "to_3f9a2c41b8d605e7a1c0", content, totalLength: 482_113, threadId: "t-1", toolCallId: "toolu_big" });

        (await store.put(record))._unsafeUnwrap();

        const read = (await store.get("analysis-a", "to_3f9a2c41b8d605e7a1c0"))._unsafeUnwrap();
        expect(content.length).toBe(300_000);
        expect(read).toEqual(record);
        expect(Buffer.from(read!.content, "utf8").equals(Buffer.from(content, "utf8"))).toBe(true);
    });

    it("gives back the thread id of a record, and no thread id for a record of a run", async () => {
        (await store.put(kept({ ref: "to_chat", threadId: "t-2" })))._unsafeUnwrap();
        (await store.put(kept({ ref: "to_run" })))._unsafeUnwrap();

        expect((await store.get("analysis-a", "to_chat"))._unsafeUnwrap()?.threadId).toBe("t-2");
        const run = (await store.get("analysis-a", "to_run"))._unsafeUnwrap();
        expect(run).not.toBeNull();
        expect(run).not.toHaveProperty("threadId");
    });

    it("replaces the text on a second put of one key, and keeps the time of the first put", async () => {
        (await store.put(kept({ ref: "to_twice", content: "first" })))._unsafeUnwrap();
        await pool.query("UPDATE cortex_tool_outputs SET created_at = '2020-01-01T00:00:00Z' WHERE ref = 'to_twice'");

        (await store.put(kept({ ref: "to_twice", content: "second", totalLength: 6 })))._unsafeUnwrap();

        expect((await store.get("analysis-a", "to_twice"))._unsafeUnwrap()).toMatchObject({ content: "second", totalLength: 6 });
        const { rows } = await pool.query<{ created_at: Date }>("SELECT created_at FROM cortex_tool_outputs WHERE ref = 'to_twice'");
        expect(rows[0]!.created_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("gives null for the reference of a different analysis", async () => {
        (await store.put(kept({ ref: "to_other" })))._unsafeUnwrap();

        expect((await store.get("analysis-b", "to_other"))._unsafeUnwrap()).toBeNull();
    });

    it("gives null for an unknown reference", async () => {
        expect((await store.get("analysis-a", "to_unknown"))._unsafeUnwrap()).toBeNull();
    });
});
