import { describe, expect, test } from "bun:test";

import type { RuleMatch } from "../knowledge/knowledge-base.js";
import { RuleRecordSchema } from "../knowledge/rule-record.js";
import { checkGrounding } from "./validate-grounding.js";
import { AnalysisPlanSchema } from "./workflow-state.js";

const match = (id: string, severity: "reject" | "warn" | "note", applicability: "applies" | "not_evaluable"): RuleMatch => ({
    rule: RuleRecordSchema.parse({
        id,
        title: `Rule ${id}`,
        applies: {},
        effect: { severity, statement: `Statement of ${id}.` },
        evidence: { sources: [{ citation: "A citation", doi: "10.1000/x" }] },
        version: "1.0.0",
    }),
    applicability,
});

const step = (id: string, grounding?: { id: string; note?: string }[]): { id: string; grounding?: { id: string; note?: string }[] } => ({
    id,
    ...(grounding ? { grounding } : {}),
});

describe("checkGrounding", () => {
    test("an unreturned citation is a violation that names the id", () => {
        const returned = new Set(["INFLEXA-R-000001"]);
        const result = checkGrounding([step("T1S1", [{ id: "INFLEXA-R-999999" }])], returned, [match("INFLEXA-R-000001", "note", "applies")]);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.path).toBe("plan.steps[0].grounding");
        expect(result.violations[0]?.message).toContain("INFLEXA-R-999999");
    });

    test("an unacknowledged applying reject rule is a violation with the statement", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "applies")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.message).toContain("INFLEXA-R-000101");
        expect(result.violations[0]?.message).toContain("Statement of INFLEXA-R-000101.");
    });

    test("a cited applying reject rule passes", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "applies")];
        const result = checkGrounding([step("T1S1", [{ id: "INFLEXA-R-000101", note: "descriptive only" }])], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.violations).toHaveLength(0);
    });

    test("a not_evaluable reject rule advises and never blocks", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "not_evaluable")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories.some((a) => a.includes("INFLEXA-R-000101"))).toBe(true);
    });

    test("an uncited applying warn rule advises and never blocks", () => {
        const matches = [match("INFLEXA-R-000201", "warn", "applies")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000201"]), matches);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories.some((a) => a.includes("INFLEXA-R-000201"))).toBe(true);
    });

    test("an uncited applying note rule also advises", () => {
        const matches = [match("INFLEXA-R-000107", "note", "applies")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000107"]), matches);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories.some((a) => a.includes("INFLEXA-R-000107"))).toBe(true);
    });

    test("no returned rules means nothing to enforce", () => {
        const result = checkGrounding([step("T1S1", undefined)], new Set(), []);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories).toHaveLength(0);
    });
});

describe("the persistence schema with grounding", () => {
    const base = {
        analytical_narrative: "A narrative.",
        created_at: "2026-08-27T00:00:00Z",
        steps: [
            {
                id: "T1S1",
                name: "A step",
                track: "T1",
                step_type: "analysis",
                question: "A question?",
                acceptance_criteria: ["Done."],
                depends_on: [],
                maxSteps: 40,
            },
        ],
    };

    test("a historical plan with no grounding field parses", () => {
        expect(AnalysisPlanSchema.safeParse(base).success).toBe(true);
    });

    test("a plan with grounded steps parses and keeps the citations", () => {
        const grounded = {
            ...base,
            steps: [{ ...base.steps[0], grounding: [{ id: "INFLEXA-R-000101", note: "descriptive log2FC only" }] }],
        };
        const parsed = AnalysisPlanSchema.safeParse(grounded);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.steps[0]?.grounding?.[0]?.id).toBe("INFLEXA-R-000101");
    });
});
