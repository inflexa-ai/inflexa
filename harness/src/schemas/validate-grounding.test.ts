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

describe("the blocking arm: citation honesty", () => {
    test("an unreturned citation is a violation that names the id", () => {
        const returned = new Set(["INFLEXA-R-000001"]);
        const result = checkGrounding([step("T1S1", [{ id: "INFLEXA-R-999999" }])], returned, [match("INFLEXA-R-000001", "note", "applies")]);
        expect(result.violations).toHaveLength(1);
        expect(result.violations[0]?.path).toBe("plan.steps[0].grounding");
        expect(result.violations[0]?.message).toContain("INFLEXA-R-999999");
    });

    test("a returned citation passes", () => {
        const result = checkGrounding([step("T1S1", [{ id: "INFLEXA-R-000101", note: "descriptive only" }])], new Set(["INFLEXA-R-000101"]), [
            match("INFLEXA-R-000101", "reject", "applies"),
        ]);
        expect(result.violations).toHaveLength(0);
    });

    test("no returned rules means nothing to enforce", () => {
        const result = checkGrounding([step("T1S1", undefined)], new Set(), []);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories).toHaveLength(0);
    });
});

describe("the advisory arm: nothing else blocks", () => {
    test("an uncited applying reject rule advises and never blocks", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "applies")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories).toHaveLength(1);
        expect(result.advisories[0]?.severity).toBe("reject");
        expect(result.advisories[0]?.message).toContain("Statement of INFLEXA-R-000101.");
    });

    test("a cited rule raises no advisory", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "applies")];
        const result = checkGrounding([step("T1S1", [{ id: "INFLEXA-R-000101" }])], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.advisories).toHaveLength(0);
    });

    test("a not_evaluable reject rule advises, and it names the remedy", () => {
        const matches = [match("INFLEXA-R-000101", "reject", "not_evaluable")];
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000101"]), matches);
        expect(result.violations).toHaveLength(0);
        expect(result.advisories[0]?.applicability).toBe("not_evaluable");
        expect(result.advisories[0]?.message).toContain("minGroupN");
    });

    test("an uncited applying warn rule advises", () => {
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000201"]), [match("INFLEXA-R-000201", "warn", "applies")]);
        expect(result.advisories.map((a) => a.ruleId)).toEqual(["INFLEXA-R-000201"]);
    });

    test("an uncited applying note rule also advises", () => {
        const result = checkGrounding([step("T1S1")], new Set(["INFLEXA-R-000107"]), [match("INFLEXA-R-000107", "note", "applies")]);
        expect(result.advisories.map((a) => a.ruleId)).toEqual(["INFLEXA-R-000107"]);
    });
});

describe("advisory ranking and the cap", () => {
    test("reject ranks first, then warn, then note", () => {
        const matches = [
            match("INFLEXA-R-000003", "note", "applies"),
            match("INFLEXA-R-000002", "warn", "applies"),
            match("INFLEXA-R-000001", "reject", "applies"),
        ];
        const ids = new Set(matches.map((m) => m.rule.id));
        const result = checkGrounding([step("T1S1")], ids, matches);
        expect(result.advisories.map((a) => a.severity)).toEqual(["reject", "warn", "note"]);
    });

    test("a reject advisory survives a flood of softer ones", () => {
        // The cap counts the soft entries only. A first-in cap used to drop
        // exactly the reject entry, because it sorts after every `applies` note.
        const noise = Array.from({ length: 30 }, (_, i) => match(`INFLEXA-R-${String(100 + i).padStart(6, "0")}`, "note", "applies"));
        const matches = [...noise, match("INFLEXA-R-000101", "reject", "not_evaluable")];
        const ids = new Set(matches.map((m) => m.rule.id));
        const result = checkGrounding([step("T1S1")], ids, matches);

        expect(result.advisories.some((a) => a.ruleId === "INFLEXA-R-000101")).toBe(true);
        expect(result.advisories[0]?.severity).toBe("reject");
        expect(result.advisories.filter((a) => a.severity !== "reject")).toHaveLength(10);
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

    test("a plan with grounded steps parses and keeps the citations and the corpus stamp", () => {
        const grounded = {
            ...base,
            steps: [
                {
                    ...base.steps[0],
                    grounding: [{ id: "INFLEXA-R-000101", note: "descriptive log2FC only", corpus: { id: "inflexa-knowledge", version: "0.1.0" } }],
                },
            ],
        };
        const parsed = AnalysisPlanSchema.safeParse(grounded);
        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.steps[0]?.grounding?.[0]?.id).toBe("INFLEXA-R-000101");
        expect(parsed.success && parsed.data.steps[0]?.grounding?.[0]?.corpus?.version).toBe("0.1.0");
    });
});
