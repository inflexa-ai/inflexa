import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../../__tests__/setup/postgres.js";
import { createWorkingMemory, WORKING_MEMORY_LIMITS, type WorkingMemoryStore } from "../../memory/working-memory.js";
import { insertRun } from "../../state/index.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createUpdateWorkingMemoryTool } from "./update-working-memory.js";

// `makeToolContext` builds a session whose workload id is "analysis-001".
const ANALYSIS = "analysis-001";

let pool: Pool;
let drop: () => Promise<void>;
let wm: WorkingMemoryStore;
let tool: ReturnType<typeof createUpdateWorkingMemoryTool>;

/** Seed a real `cortex_runs` row — a finding may only cite a run that exists. */
async function seedRun(runId: string, analysisId: string = ANALYSIS): Promise<string> {
    (await insertRun(pool, { runId, analysisId, workflowName: "executeAnalysis" }))._unsafeUnwrap();
    return runId;
}

beforeEach(async () => {
    ({ pool, drop } = await withSchema("update_working_memory"));
    wm = createWorkingMemory(pool);
    tool = createUpdateWorkingMemoryTool(wm, pool);
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
        await seedRun("run-A");

        const result = await tool.execute({ section: "finding", runId: "run-A", text: "412 genes DE" }, ctx);

        expect(result.isOk()).toBe(true);
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

describe("findings can be revised and retired", () => {
    it("revises a finding by its own id — no runId needed", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-A");
        await tool.execute({ section: "finding", runId: "run-A", text: "412 genes DE" }, ctx);
        const id = (await wm.load(ANALYSIS))._unsafeUnwrap().findings["run-A"]![0]!.id;

        const result = await tool.execute({ section: "finding", operation: "revise", id, text: "412 genes DE (ComBat-corrected)" }, ctx);

        expect(result.isOk()).toBe(true);
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]).toEqual([{ id, text: "412 genes DE (ComBat-corrected)" }]);
    });

    it("retires a finding, and the run it cited disappears with it", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-A");
        await tool.execute({ section: "finding", runId: "run-A", text: "a superseded conclusion" }, ctx);
        const id = (await wm.load(ANALYSIS))._unsafeUnwrap().findings["run-A"]![0]!.id;

        const result = await tool.execute({ section: "finding", operation: "retire", id }, ctx);

        expect(result.isOk()).toBe(true);
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings).toEqual({});

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();
        expect(md).not.toContain("a superseded conclusion");
        expect(md).not.toContain("run-A");
    });

    it("rejects a retire whose id addresses nothing, leaving state untouched", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-A");
        await tool.execute({ section: "finding", runId: "run-A", text: "the real finding" }, ctx);

        const result = await tool.execute({ section: "finding", operation: "retire", id: "deadbeef" }, ctx);

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr().error).toContain("deadbeef");

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]!.map((f) => f.text)).toEqual(["the real finding"]);
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

    it("accepts a finding retire without a runId — the id names the finding", () => {
        const result = tool.inputSchema.safeParse({
            section: "finding",
            operation: "retire",
            id: "f1a2b3c4",
        });
        expect(result.success).toBe(true);
    });
});

describe("caps are model-visible and never silently truncate", () => {
    it("rejects an over-long entry at the input schema, with an actionable message", async () => {
        const { ctx } = makeToolContext();
        const overLong = "x".repeat(WORKING_MEMORY_LIMITS.entryChars + 1);

        const parsed = tool.inputSchema.safeParse({ section: "constraint", text: overLong });
        expect(parsed.success).toBe(false);
        const message = parsed.success ? "" : parsed.error.issues.map((i) => i.message).join(" ");
        expect(message).toContain(`${WORKING_MEMORY_LIMITS.entryChars}`);
        expect(message.toLowerCase()).toContain("rewrite");

        // The loop never calls `execute` on a schema failure — state is untouched
        // either way, and the truncated text is nowhere.
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints).toEqual([]);

        // The same text is accepted once it is inside the cap.
        const ok = await tool.execute({ section: "constraint", text: "x".repeat(WORKING_MEMORY_LIMITS.entryChars) }, ctx);
        expect(ok.isOk()).toBe(true);
    });

    it("rejects an over-long goal at the input schema", () => {
        const parsed = tool.inputSchema.safeParse({
            section: "goal",
            text: "g".repeat(WORKING_MEMORY_LIMITS.goalChars + 1),
        });
        expect(parsed.success).toBe(false);
    });

    it("rejects an add into a full section, telling the model to retire first", async () => {
        const { ctx } = makeToolContext();
        for (let i = 0; i < WORKING_MEMORY_LIMITS.hypotheses; i++) {
            (await tool.execute({ section: "hypothesis", text: `hypothesis ${i}` }, ctx))._unsafeUnwrap();
        }
        const before = (await wm.load(ANALYSIS))._unsafeUnwrap();

        const result = await tool.execute({ section: "hypothesis", text: "one hypothesis too many" }, ctx);

        expect(result.isErr()).toBe(true);
        const { error, retryable } = result._unsafeUnwrapErr();
        expect(error).toContain("retire");
        expect(retryable).toBe(true);

        // State: capped, unchanged, and the refused entry is not in the render.
        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
        expect(after.hypotheses.length).toBe(WORKING_MEMORY_LIMITS.hypotheses);
        expect((await wm.render(ANALYSIS))._unsafeUnwrap()).not.toContain("one hypothesis too many");
    });
});

describe("finding runId must name a real run of this analysis", () => {
    it("rejects a finding whose runId does not exist, leaving working memory untouched", async () => {
        const { ctx } = makeToolContext();

        const result = await tool.execute({ section: "finding", runId: "run-hallucinated", text: "a finding from nowhere" }, ctx);

        expect(result.isErr()).toBe(true);
        // The message has to tell the model how to recover — a phantom run would
        // otherwise be cited by a finding that renders on every later turn.
        const { error, retryable } = result._unsafeUnwrapErr();
        expect(error).toContain("run-hallucinated");
        expect(error).toContain("inspect_run");
        expect(retryable).toBe(true);

        // State: no phantom bucket, and nothing renders into the next turn.
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-hallucinated"]).toBeUndefined();
        expect(Object.keys(loaded.findings)).toEqual([]);

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();
        expect(md).toBe("");
    });

    it("rejects a finding citing a run that belongs to a different analysis", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-other", "analysis-999");

        const result = await tool.execute({ section: "finding", runId: "run-other", text: "another analysis's result" }, ctx);

        expect(result.isErr()).toBe(true);
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-other"]).toBeUndefined();
        expect(Object.keys(loaded.findings)).toEqual([]);
    });

    it("stores a finding whose runId names a real run, and renders it as a run-referenced line", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-real");

        const result = await tool.execute({ section: "finding", runId: "run-real", text: "412 genes differentially expressed" }, ctx);

        expect(result.isOk()).toBe(true);
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-real"]!.map((f) => f.text)).toEqual(["412 genes differentially expressed"]);

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();
        expect(md).toContain("(run-real) 412 genes differentially expressed");
        expect(md).not.toContain("### Run");
    });

    it("a rejected finding does not disturb findings already recorded under a real run", async () => {
        const { ctx } = makeToolContext();
        await seedRun("run-real");
        await tool.execute({ section: "finding", runId: "run-real", text: "the real finding" }, ctx);

        const result = await tool.execute({ section: "finding", runId: "run-typo", text: "the typo'd finding" }, ctx);
        expect(result.isErr()).toBe(true);

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();
        expect(md).toContain("(run-real) the real finding");
        expect(md).not.toContain("run-typo");
        expect(md).not.toContain("the typo'd finding");
    });
});
