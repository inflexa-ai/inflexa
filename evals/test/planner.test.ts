import { describe, expect, test } from "bun:test";

import { plannerCases } from "../cases/planner.js";
import type { Trial } from "../lib/case.js";

type Step = { id: string; agent: string; name: string; question: string; depends_on: string[] };

function planned(steps: readonly Step[]): Trial {
    return {
        calls: [{ step: 0, tool: "submit_plan", input: { plan: { steps } }, refused: false }],
        asks: [],
        text: "",
        finishReason: "stop",
        stepFinishes: [],
        capped: false,
    };
}

function gradeOf(id: string, trial: Trial): boolean {
    const evalCase = plannerCases.find((c) => c.id === id);
    if (evalCase === undefined) throw new Error(`no case ${id}`);
    return evalCase.grade(trial).pass;
}

const DE = {
    id: "T1S1",
    agent: "analyst",
    name: "Differential expression",
    question: "Which genes differ between responders and non-responders?",
    depends_on: [],
};
const IMMUNE = {
    id: "T2S1",
    agent: "analyst",
    name: "Immune cell composition",
    question: "What is the immune cell composition of each biopsy?",
    depends_on: [],
};

describe("the dependencies of a plan follow its data", () => {
    test("passes the DE and the enrichment in one step, beside an immune step that waits for nothing", () => {
        const merged = { ...DE, name: "DE and hallmark enrichment" };
        expect(gradeOf("plan-dependencies-follow-data", planned([merged, IMMUNE]))).toBe(true);
    });

    test("passes an enrichment step after the DE step", () => {
        const enrichment = { id: "T1S2", agent: "analyst", name: "Hallmark enrichment", question: "Which pathways are enriched?", depends_on: ["T1S1"] };
        expect(gradeOf("plan-dependencies-follow-data", planned([DE, enrichment, IMMUNE]))).toBe(true);
    });

    test("takes the DE step as the enrichment when it names the enrichment, also when the immune step names a pathway", () => {
        const merged = { ...DE, name: "DE and pathway enrichment" };
        const immune = { ...IMMUNE, question: "How does the immune composition differ, and which pathways mark it?" };
        expect(gradeOf("plan-dependencies-follow-data", planned([merged, immune]))).toBe(true);
    });

    test("fails an immune step that waits for the enrichment", () => {
        const merged = { ...DE, name: "DE and hallmark enrichment" };
        expect(gradeOf("plan-dependencies-follow-data", planned([merged, { ...IMMUNE, depends_on: ["T1S1"] }]))).toBe(false);
    });
});
