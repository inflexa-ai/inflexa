import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import {
    createWorkingMemory,
    emptyWorkingMemory,
    isWorkingMemoryRejection,
    renderWorkingMemory,
    WORKING_MEMORY_LIMITS,
    type WorkingMemory,
    type WorkingMemoryStore,
    workingMemorySchema,
} from "./working-memory.js";

const ANALYSIS = "analysis-wm-1";

/** A fully-populated working memory for schema and render tests. */
const populated: WorkingMemory = {
    goal: "Identify drivers of treatment resistance in the cohort",
    constraints: [
        { id: "c1", text: "FDR threshold 0.01", origin: "user" },
        { id: "c2", text: "Data is paired — all tests must be paired", origin: "agent" },
    ],
    hypotheses: [{ id: "h1", text: "EGFR amplification drives resistance" }],
    findings: {
        "run-A": [{ id: "f1", text: "412 genes differentially expressed" }],
        "run-B": [{ id: "f2", text: "Pathway X enriched at FDR 0.003" }],
    },
};

// --- schema (1.3) -----------------------------------------------------------

describe("workingMemorySchema", () => {
    it("parses an empty/initial working memory", () => {
        const parsed = workingMemorySchema.parse(emptyWorkingMemory());
        expect(parsed).toEqual({
            goal: "",
            constraints: [],
            hypotheses: [],
            findings: {},
        });
    });

    it("parses a fully populated working memory", () => {
        expect(workingMemorySchema.parse(populated)).toEqual(populated);
    });

    it("rejects a malformed section", () => {
        // A constraint missing its `origin` metadata.
        const malformed = {
            goal: "",
            constraints: [{ id: "c1", text: "no origin here" }],
            hypotheses: [],
            findings: {},
        };
        expect(workingMemorySchema.safeParse(malformed).success).toBe(false);

        // `goal` must be a string, not a number.
        const badGoal = { ...emptyWorkingMemory(), goal: 42 };
        expect(workingMemorySchema.safeParse(badGoal).success).toBe(false);
    });
});

// --- module -----------------------------------------------------------------

let pool: Pool;
let drop: () => Promise<void>;
let wm: WorkingMemoryStore;

beforeEach(async () => {
    ({ pool, drop } = await withSchema("working-memory"));
    wm = createWorkingMemory(pool);
});

afterEach(async () => {
    await drop();
});

describe("load", () => {
    it("returns the initial shape without inserting a row", async () => {
        expect((await wm.load(ANALYSIS))._unsafeUnwrap()).toEqual(emptyWorkingMemory());

        const { rows } = await pool.query("SELECT 1 FROM cortex_working_memory WHERE analysis_id = $1", [ANALYSIS]);
        expect(rows.length).toBe(0);
    });
});

describe("updateSection section isolation (2.5)", () => {
    it("updating constraints leaves goal / hypotheses / findings byte-identical", async () => {
        (await wm.updateSection(ANALYSIS, "goal", { text: "the analysis goal" }))._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "add",
                text: "a working hypothesis",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "finding", {
                op: "add",
                runId: "run-A",
                text: "a recorded finding",
            })
        )._unsafeUnwrap();

        const before = (await wm.load(ANALYSIS))._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "constraint", {
                op: "add",
                text: "FDR threshold 0.01",
                origin: "user",
            })
        )._unsafeUnwrap();
        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();

        expect(after.goal).toBe(before.goal);
        expect(JSON.stringify(after.hypotheses)).toBe(JSON.stringify(before.hypotheses));
        expect(JSON.stringify(after.findings)).toBe(JSON.stringify(before.findings));
        expect(after.constraints.length).toBe(1);
        expect(after.constraints[0]!.text).toBe("FDR threshold 0.01");
    });

    it("revising and retiring list entries amends only that section", async () => {
        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "add",
                text: "first hypothesis",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "add",
                text: "second hypothesis",
            })
        )._unsafeUnwrap();
        const seeded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        const [first, second] = seeded.hypotheses;

        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "revise",
                id: first!.id,
                text: "first hypothesis (refined)",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "retire",
                id: second!.id,
            })
        )._unsafeUnwrap();

        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(after.hypotheses.length).toBe(1);
        expect(after.hypotheses[0]!.id).toBe(first!.id);
        expect(after.hypotheses[0]!.text).toBe("first hypothesis (refined)");
    });
});

describe("updateSection run-scoped findings (2.6)", () => {
    it("recording a finding under run B does not disturb run A", async () => {
        (
            await wm.updateSection(ANALYSIS, "finding", {
                op: "add",
                runId: "run-A",
                text: "finding from run A",
            })
        )._unsafeUnwrap();
        const afterA = (await wm.load(ANALYSIS))._unsafeUnwrap();
        const runABefore = afterA.findings["run-A"];

        (
            await wm.updateSection(ANALYSIS, "finding", {
                op: "add",
                runId: "run-B",
                text: "finding from run B",
            })
        )._unsafeUnwrap();
        const afterB = (await wm.load(ANALYSIS))._unsafeUnwrap();

        expect(JSON.stringify(afterB.findings["run-A"])).toBe(JSON.stringify(runABefore));
        expect(afterB.findings["run-B"]!.length).toBe(1);
        expect(afterB.findings["run-B"]![0]!.text).toBe("finding from run B");
    });

    it("appends multiple findings under the same run", async () => {
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "first finding" }))._unsafeUnwrap();
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "second finding" }))._unsafeUnwrap();
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]!.map((f) => f.text)).toEqual(["first finding", "second finding"]);
    });
});

describe("findings are revisable and retirable", () => {
    it("revises a finding's text in place, keeping its id and run", async () => {
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "412 genes DE" }))._unsafeUnwrap();
        const id = (await wm.load(ANALYSIS))._unsafeUnwrap().findings["run-A"]![0]!.id;

        (await wm.updateSection(ANALYSIS, "finding", { op: "revise", id, text: "412 genes DE — batch-corrected" }))._unsafeUnwrap();

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]).toEqual([{ id, text: "412 genes DE — batch-corrected" }]);
    });

    it("retires a finding, dropping the run bucket once it holds nothing", async () => {
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "kept" }))._unsafeUnwrap();
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-B", text: "retired" }))._unsafeUnwrap();
        const seeded = (await wm.load(ANALYSIS))._unsafeUnwrap();

        (await wm.updateSection(ANALYSIS, "finding", { op: "retire", id: seeded.findings["run-B"]![0]!.id }))._unsafeUnwrap();

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        // The emptied run is gone entirely — no phantom key, nothing to render.
        expect(Object.keys(loaded.findings)).toEqual(["run-A"]);
        expect((await wm.render(ANALYSIS))._unsafeUnwrap()).not.toContain("run-B");
    });

    it("rejects a revise/retire whose id addresses nothing, leaving state untouched", async () => {
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "the only finding" }))._unsafeUnwrap();
        const before = (await wm.load(ANALYSIS))._unsafeUnwrap();

        // `_unsafeUnwrapErr` throws on ok — unwrapping IS the assertion that the
        // write was refused.
        const error = (await wm.updateSection(ANALYSIS, "finding", { op: "retire", id: "nosuchid" }))._unsafeUnwrapErr();

        expect(isWorkingMemoryRejection(error)).toBe(true);
        expect(isWorkingMemoryRejection(error) && error.message).toContain("nosuchid");

        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    });
});

describe("write-time caps", () => {
    /** `n` distinct entries of the given section, added straight through the store. */
    async function fill(section: "constraint" | "hypothesis", n: number): Promise<void> {
        for (let i = 0; i < n; i++) {
            const value = section === "constraint" ? ({ op: "add", text: `rule ${i}`, origin: "agent" } as const) : ({ op: "add", text: `hyp ${i}` } as const);
            (await wm.updateSection(ANALYSIS, section, value))._unsafeUnwrap();
        }
    }

    it("refuses an add into a full constraints section and tells the model to retire first", async () => {
        await fill("constraint", WORKING_MEMORY_LIMITS.constraints);
        const before = (await wm.load(ANALYSIS))._unsafeUnwrap();

        const error = (await wm.updateSection(ANALYSIS, "constraint", { op: "add", text: "one rule too many", origin: "user" }))._unsafeUnwrapErr();

        expect(isWorkingMemoryRejection(error)).toBe(true);
        const message = isWorkingMemoryRejection(error) ? error.message : "";
        expect(message).toContain("retire");
        expect(message).toContain(`${WORKING_MEMORY_LIMITS.constraints}`);

        // State: nothing was appended, nothing was evicted to make room.
        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(after.constraints.length).toBe(WORKING_MEMORY_LIMITS.constraints);
        expect(JSON.stringify(after)).toBe(JSON.stringify(before));

        // And it stays refused until something is retired — then it lands.
        (await wm.updateSection(ANALYSIS, "constraint", { op: "retire", id: before.constraints[0]!.id }))._unsafeUnwrap();
        (await wm.updateSection(ANALYSIS, "constraint", { op: "add", text: "one rule too many", origin: "user" }))._unsafeUnwrap();
        const reopened = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(reopened.constraints.length).toBe(WORKING_MEMORY_LIMITS.constraints);
        expect(reopened.constraints[reopened.constraints.length - 1]!.text).toBe("one rule too many");
    });

    it("refuses an add into a full hypotheses section", async () => {
        await fill("hypothesis", WORKING_MEMORY_LIMITS.hypotheses);

        const result = await wm.updateSection(ANALYSIS, "hypothesis", { op: "add", text: "one hypothesis too many" });

        expect(result.isErr()).toBe(true);
        const after = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(after.hypotheses.length).toBe(WORKING_MEMORY_LIMITS.hypotheses);
        expect(after.hypotheses.some((h) => h.text === "one hypothesis too many")).toBe(false);
    });

    it("caps findings across every run, not per run", async () => {
        for (let i = 0; i < WORKING_MEMORY_LIMITS.findings; i++) {
            // Spread over several runs — the cap is on the section as a whole.
            (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: `run-${i % 5}`, text: `finding ${i}` }))._unsafeUnwrap();
        }

        const result = await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-0", text: "one finding too many" });

        expect(result.isErr()).toBe(true);
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        const total = Object.values(loaded.findings).reduce((n, list) => n + list.length, 0);
        expect(total).toBe(WORKING_MEMORY_LIMITS.findings);
        expect((await wm.render(ANALYSIS))._unsafeUnwrap()).not.toContain("one finding too many");
    });

    it("refuses an over-long entry and an over-long goal, storing neither", async () => {
        (await wm.updateSection(ANALYSIS, "goal", { text: "the original goal" }))._unsafeUnwrap();

        const longEntry = "x".repeat(WORKING_MEMORY_LIMITS.entryChars + 1);
        const entryResult = await wm.updateSection(ANALYSIS, "constraint", { op: "add", text: longEntry, origin: "agent" });
        expect(entryResult.isErr()).toBe(true);

        const longGoal = "y".repeat(WORKING_MEMORY_LIMITS.goalChars + 1);
        const goalResult = await wm.updateSection(ANALYSIS, "goal", { text: longGoal });
        expect(goalResult.isErr()).toBe(true);

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints).toEqual([]);
        expect(loaded.goal).toBe("the original goal");
    });
});

describe("render", () => {
    it("renders an empty working memory as the empty string", () => {
        expect(renderWorkingMemory(emptyWorkingMemory())).toBe("");
    });

    it("omits empty sections entirely — no heading, no placeholder", () => {
        const md = renderWorkingMemory({
            ...emptyWorkingMemory(),
            goal: "only the goal is set",
        });
        expect(md).toContain("## Goal");
        expect(md).toContain("only the goal is set");
        expect(md).not.toContain("## Constraints");
        expect(md).not.toContain("## Hypotheses");
        expect(md).not.toContain("## Findings");
        expect(md).not.toContain("none yet");
    });

    it("renders findings as one flat list, each line citing its run", () => {
        const md = renderWorkingMemory(populated);

        expect(md).toContain("- [f1] (run-A) 412 genes differentially expressed");
        expect(md).toContain("- [f2] (run-B) Pathway X enriched at FDR 0.003");
        expect(md).toContain("- [c1] (user) FDR threshold 0.01");
        expect(md).toContain("- [h1] EGFR amplification drives resistance");
        // No per-run heading blocks — memory holds run references, not run sections.
        expect(md).not.toContain("### Run");
    });

    it("renders the flat list end-to-end through the store", async () => {
        (await wm.updateSection(ANALYSIS, "goal", { text: "the analysis goal" }))._unsafeUnwrap();
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-A", text: "412 genes differentially expressed" }))._unsafeUnwrap();
        (await wm.updateSection(ANALYSIS, "finding", { op: "add", runId: "run-B", text: "pathway X enriched" }))._unsafeUnwrap();

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();

        expect(md).toContain("(run-A) 412 genes differentially expressed");
        expect(md).toContain("(run-B) pathway X enriched");
        expect(md).not.toContain("### Run");
    });
});

describe("legacy rows written before the caps existed", () => {
    /** A row far over every cap, as an older host could have written it. */
    const oversized: WorkingMemory = {
        goal: "g".repeat(2_000),
        constraints: Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, text: `rule ${i}`, origin: "agent" as const })),
        hypotheses: Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, text: `hyp ${i}` })),
        findings: {
            "run-legacy": Array.from({ length: 60 }, (_, i) => ({ id: `f${i}`, text: `finding ${i}`.padEnd(1_000, "!") })),
        },
    };

    beforeEach(async () => {
        await pool.query("INSERT INTO cortex_working_memory (analysis_id, data, updated_at) VALUES ($1, $2::jsonb, NOW())", [
            ANALYSIS,
            JSON.stringify(oversized),
        ]);
    });

    it("loads without throwing", async () => {
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints.length).toBe(40);
        expect(loaded.findings["run-legacy"]!.length).toBe(60);
    });

    it("renders bounded — newest entries only, every line inside the caps", async () => {
        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();

        const bullets = md.split("\n").filter((l) => l.startsWith("- ["));
        const constraintLines = bullets.filter((l) => l.includes("(agent)"));
        const findingLines = bullets.filter((l) => l.includes("(run-legacy)"));
        expect(constraintLines.length).toBe(WORKING_MEMORY_LIMITS.constraints);
        expect(findingLines.length).toBe(WORKING_MEMORY_LIMITS.findings);

        // Newest kept, oldest dropped — and the drop is stated, not silent.
        expect(md).toContain("finding 59");
        expect(md).not.toContain("finding 0!");
        expect(md).toContain("30 older findings omitted");

        // Every entry line is clamped, and the goal with it.
        for (const line of bullets) expect(line.length).toBeLessThan(WORKING_MEMORY_LIMITS.entryChars + 40);
        expect(md).toContain("…");
        expect(md.length).toBeLessThan(20_000);
    });

    it("still accepts a retire, so an over-cap row can be brought back under the caps", async () => {
        (await wm.updateSection(ANALYSIS, "constraint", { op: "retire", id: "c0" }))._unsafeUnwrap();

        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.constraints.length).toBe(39);
        expect(loaded.constraints.some((c) => c.id === "c0")).toBe(false);
    });
});
