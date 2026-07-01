import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { createWorkingMemory, type WorkingMemoryStore } from "../../memory/working-memory.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createUpdateWorkingMemoryTool } from "./update-working-memory.js";

// `makeToolContext` builds a session whose workload id is "analysis-001".
const ANALYSIS = "analysis-001";

let pool: Pool;
let drop: () => Promise<void>;
let wm: WorkingMemoryStore;
let tool: ReturnType<typeof createUpdateWorkingMemoryTool>;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("update_working_memory"));
    wm = createWorkingMemory(pool);
    tool = createUpdateWorkingMemoryTool(wm);
});

afterEach(async () => {
    await drop();
});

describe("section routing", () => {
    it("a 'goal' update replaces the goal section", async () => {
        const { ctx } = makeToolContext();
        await tool.execute({ section: "goal", text: "discover resistance drivers" }, ctx);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.goal).toBe("discover resistance drivers");
    });

    it("a 'constraint' update appends to the constraints section", async () => {
        const { ctx } = makeToolContext();
        await tool.execute({ section: "constraint", text: "FDR threshold 0.01", origin: "user" }, ctx);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints.length).toBe(1);
        expect(loaded.constraints[0]!.text).toBe("FDR threshold 0.01");
        expect(loaded.constraints[0]!.origin).toBe("user");
    });

    it("a 'hypothesis' update appends to the hypotheses section", async () => {
        const { ctx } = makeToolContext();
        await tool.execute({ section: "hypothesis", text: "EGFR amplification drives resistance" }, ctx);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.hypotheses.length).toBe(1);
        expect(loaded.hypotheses[0]!.text).toBe("EGFR amplification drives resistance");
    });

    it("a 'finding' update records under the given runId", async () => {
        const { ctx } = makeToolContext();
        await tool.execute({ section: "finding", runId: "run-A", text: "412 genes DE" }, ctx);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]!.length).toBe(1);
        expect(loaded.findings["run-A"]![0]!.text).toBe("412 genes DE");
    });

    it("a 'constraint' revise addresses an existing entry by id", async () => {
        const { ctx } = makeToolContext();
        await tool.execute({ section: "constraint", text: "FDR 0.05", origin: "agent" }, ctx);
        const seeded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        const id = seeded.constraints[0]!.id;

        await tool.execute({ section: "constraint", operation: "revise", id, text: "FDR 0.01" }, ctx);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints.length).toBe(1);
        expect(loaded.constraints[0]!.text).toBe("FDR 0.01");
    });
});

describe("input validation", () => {
    it("rejects a 'finding' with no runId", () => {
        const result = tool.inputSchema.safeParse({
            section: "finding",
            text: "a finding with no run",
        });
        expect(result.success).toBe(false);
    });

    it("rejects a 'goal' with no text", () => {
        const result = tool.inputSchema.safeParse({ section: "goal" });
        expect(result.success).toBe(false);
    });

    it("rejects a 'revise' with no id", () => {
        const result = tool.inputSchema.safeParse({
            section: "hypothesis",
            operation: "revise",
            text: "revised text",
        });
        expect(result.success).toBe(false);
    });

    it("accepts a well-formed finding", () => {
        const result = tool.inputSchema.safeParse({
            section: "finding",
            runId: "run-A",
            text: "a valid finding",
        });
        expect(result.success).toBe(true);
    });
});
