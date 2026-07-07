import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Pool } from "pg";

import { withSchema } from "../__tests__/setup/postgres.js";
import {
    createWorkingMemory,
    emptyWorkingMemory,
    renderWorkingMemory,
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
                runId: "run-A",
                text: "finding from run A",
            })
        )._unsafeUnwrap();
        const afterA = (await wm.load(ANALYSIS))._unsafeUnwrap();
        const runABefore = afterA.findings["run-A"];

        (
            await wm.updateSection(ANALYSIS, "finding", {
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
        (
            await wm.updateSection(ANALYSIS, "finding", {
                runId: "run-A",
                text: "first finding",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "finding", {
                runId: "run-A",
                text: "second finding",
            })
        )._unsafeUnwrap();
        const loaded = (await wm.load(ANALYSIS))._unsafeUnwrap();
        expect(loaded.findings["run-A"]!.map((f) => f.text)).toEqual(["first finding", "second finding"]);
    });
});

describe("render (2.7)", () => {
    it("groups findings by run and includes all four sections", async () => {
        (await wm.updateSection(ANALYSIS, "goal", { text: "the analysis goal" }))._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "constraint", {
                op: "add",
                text: "FDR threshold 0.01",
                origin: "user",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "hypothesis", {
                op: "add",
                text: "EGFR drives resistance",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "finding", {
                runId: "run-A",
                text: "412 genes differentially expressed",
            })
        )._unsafeUnwrap();
        (
            await wm.updateSection(ANALYSIS, "finding", {
                runId: "run-B",
                text: "pathway X enriched",
            })
        )._unsafeUnwrap();

        const md = (await wm.render(ANALYSIS))._unsafeUnwrap();

        expect(md).toContain("## Goal");
        expect(md).toContain("## Constraints");
        expect(md).toContain("## Hypotheses");
        expect(md).toContain("## Findings");
        expect(md).toContain("the analysis goal");
        expect(md).toContain("FDR threshold 0.01");
        expect(md).toContain("EGFR drives resistance");
        expect(md).toContain("### Run run-A");
        expect(md).toContain("### Run run-B");
        expect(md).toContain("412 genes differentially expressed");
        expect(md).toContain("pathway X enriched");
    });

    it("renders empty sections as an explicit 'none yet' line", () => {
        const md = renderWorkingMemory({
            ...emptyWorkingMemory(),
            goal: "only the goal is set",
            findings: { "run-A": [{ id: "f1", text: "one finding" }] },
        });
        expect(md).toContain("## Goal");
        expect(md).toContain("## Constraints");
        expect(md).toContain("## Hypotheses");
        expect(md).toContain("## Findings");
        // Constraints and hypotheses are empty — shown, not omitted.
        expect(md).toContain("none yet");
        expect(md).toContain("only the goal is set");
        expect(md).toContain("one finding");
    });
});
