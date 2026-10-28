import { describe, expect, it } from "bun:test";

import { formatPriorPlan } from "../../tools/research/generate-plan.js";
import { packagesSection, plannerPrompt } from "../planner.js";

describe("plannerPrompt — the packages of each step", () => {
    it("the prompt names the prefix", () => {
        // The spec scenario of the same name. The census marks a both-track
        // name with the two forms, and this section is what turns that mark
        // into the string the planner writes.
        const prompt = plannerPrompt("- agent-a: does a thing");

        expect(prompt).toContain("under a Python section AND under an R");
        expect(prompt).toContain('"python:igraph"');
        expect(prompt).toContain('"r:igraph"');
        expect(prompt).toContain("A bare name that both tracks hold refuses the launch");
    });

    it("the section carries the prefixed form to every surface that asks for the array", () => {
        // The router prompt teaches the grammar from this one text. A second
        // text would drift, and a spelling rule that one surface states and
        // the other omits is a launch refusal on the silent one.
        const section = packagesSection();

        expect(section).toContain('"python:igraph"');
        expect(section).toContain('"r:igraph"');
        expect(plannerPrompt("- agent-a: does a thing")).toContain(section);
    });
});

describe("the revision rules ride the prior plan block", () => {
    it("the block of a prior plan names the rules, and the system prompt holds no revision section", () => {
        const block = formatPriorPlan("pln-1a2b3c4d", {
            analytical_narrative: "DE, then pathways.",
            created_at: "2026-10-27T09:00:00.000Z",
            steps: [
                {
                    id: "T1S1",
                    name: "Differential expression",
                    track: "T1",
                    step_type: "analysis",
                    question: "Which genes change?",
                    acceptance_criteria: ["A results table"],
                    depends_on: [],
                    maxSteps: 40,
                },
            ],
        });

        expect(block).toContain("Each step keeps its id, its agent, and its order, also a step that the user asked to change");
        expect(block).toContain("Give a new id to new work only.");
        expect(plannerPrompt("- agent-a: does a thing")).not.toContain("Prior Plan");
    });
});
