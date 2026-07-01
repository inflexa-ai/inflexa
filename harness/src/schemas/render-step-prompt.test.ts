import { describe, expect, it } from "bun:test";

import { AnalysisStepSchema } from "./workflow-state.js";
import type { AnalysisStep } from "./workflow-state.js";
import { renderStepPrompt, STEP_PROMPT_INSTRUCTION_FIELDS, STEP_PROMPT_NON_INSTRUCTION_FIELDS } from "./render-step-prompt.js";

/** A step whose every instruction field carries a unique, greppable sentinel. */
function fullyPopulatedStep(): AnalysisStep {
    return {
        id: "T1S1",
        name: "SENTINEL_NAME",
        track: "T1",
        step_type: "analysis",
        question: "SENTINEL_QUESTION",
        description: "SENTINEL_DESCRIPTION",
        context: "SENTINEL_CONTEXT",
        constraints: ["SENTINEL_CONSTRAINT_A", "SENTINEL_CONSTRAINT_B"],
        acceptance_criteria: ["SENTINEL_ACCEPTANCE"],
        caveats: ["SENTINEL_CAVEAT"],
        depends_on: [],
        status: "pending",
        resources: { cpu: 1, memoryGb: 2 },
        agent: "bulk-transcriptomics-agent",
        maxSteps: 10,
    };
}

describe("renderStepPrompt", () => {
    it("includes the content of every instruction-bearing field", () => {
        const prompt = renderStepPrompt(fullyPopulatedStep());
        // Behavioural, not formatting-coupled: we assert the field VALUES survive
        // the render, not the exact headings or layout around them.
        for (const sentinel of [
            "SENTINEL_NAME",
            "SENTINEL_QUESTION",
            "SENTINEL_DESCRIPTION",
            "SENTINEL_CONTEXT",
            "SENTINEL_CONSTRAINT_A",
            "SENTINEL_CONSTRAINT_B",
            "SENTINEL_ACCEPTANCE",
            "SENTINEL_CAVEAT",
        ]) {
            expect(prompt).toContain(sentinel);
        }
    });

    it("renders a sparse step (question only) without empty sections", () => {
        const prompt = renderStepPrompt({
            ...fullyPopulatedStep(),
            description: undefined,
            context: undefined,
            constraints: undefined,
            caveats: undefined,
            // acceptance_criteria is required by the schema; keep one.
            acceptance_criteria: ["SENTINEL_ACCEPTANCE"],
        });
        expect(prompt).toContain("SENTINEL_QUESTION");
        // No heading should be emitted with an empty body.
        expect(prompt).not.toMatch(/##[^\n]*\n\s*(\n|$)/);
    });

    it("does not silently drop multi-element array fields", () => {
        const prompt = renderStepPrompt({
            ...fullyPopulatedStep(),
            constraints: ["C1", "C2", "C3", "C4"],
            acceptance_criteria: ["AC1", "AC2"],
        });
        for (const v of ["C1", "C2", "C3", "C4", "AC1", "AC2"]) {
            expect(prompt).toContain(v);
        }
    });
});

describe("AnalysisStep field-coverage guard", () => {
    // The point of this suite: when someone ADDS a field to AnalysisStepSchema,
    // one of these tests fails until they make a deliberate decision about
    // whether the sandbox agent needs to see it. It does not assert layout, so
    // wording/format changes to the renderer never break it.

    const schemaKeys = Object.keys(AnalysisStepSchema.shape) as (keyof AnalysisStep)[];

    it("classifies every schema field as instruction or non-instruction", () => {
        const instruction = new Set<string>(STEP_PROMPT_INSTRUCTION_FIELDS);
        const nonInstruction = new Set<string>(STEP_PROMPT_NON_INSTRUCTION_FIELDS);

        const unclassified = schemaKeys.filter((k) => !instruction.has(k) && !nonInstruction.has(k));
        expect(
            unclassified,
            `New AnalysisStep field(s) ${JSON.stringify(unclassified)} are not classified. ` +
                "Add each to STEP_PROMPT_INSTRUCTION_FIELDS (and render it in renderStepPrompt) " +
                "or to STEP_PROMPT_NON_INSTRUCTION_FIELDS, depending on whether the sandbox " +
                "agent needs to see it.",
        ).toEqual([]);
    });

    it("never classifies a field as both instruction and non-instruction", () => {
        const overlap = STEP_PROMPT_INSTRUCTION_FIELDS.filter((f) => (STEP_PROMPT_NON_INSTRUCTION_FIELDS as readonly string[]).includes(f));
        expect(overlap).toEqual([]);
    });

    it("does not reference fields that no longer exist on the schema", () => {
        const all = [...STEP_PROMPT_INSTRUCTION_FIELDS, ...STEP_PROMPT_NON_INSTRUCTION_FIELDS];
        const stale = all.filter((f) => !schemaKeys.includes(f));
        expect(stale, `Field(s) ${JSON.stringify(stale)} are listed in render-step-prompt.ts ` + "but no longer exist on AnalysisStepSchema.").toEqual([]);
    });

    it("actually renders every field declared as instruction-bearing", () => {
        // Build a step with a unique sentinel per instruction field, driven off
        // the declared field list so a newly-declared instruction field that the
        // renderer forgets to emit is caught here.
        const base = fullyPopulatedStep();
        const sentinels = new Map<string, string>();
        const step = { ...base } as Record<string, unknown>;
        for (const field of STEP_PROMPT_INSTRUCTION_FIELDS) {
            const sentinel = `COVER_${field.toUpperCase()}`;
            sentinels.set(field, sentinel);
            const current = (base as Record<string, unknown>)[field];
            step[field] = Array.isArray(current) ? [sentinel] : sentinel;
        }
        const prompt = renderStepPrompt(step as unknown as AnalysisStep);
        for (const [field, sentinel] of sentinels) {
            expect(prompt, `instruction field "${field}" is not rendered`).toContain(sentinel);
        }
    });
});
