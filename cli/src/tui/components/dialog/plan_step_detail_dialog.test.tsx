import { describe, expect, test } from "bun:test";
import { renderFrame } from "../../../test_support/tui.ts";

import { PlanStepDetailDialog, planStepDetailLines } from "./plan_step_detail_dialog.tsx";
import type { PlanCardStepView } from "../../../types/session.ts";

const detailStep: PlanCardStepView = {
    id: "T1S2",
    name: "Fit DE model",
    agent: "deseq2",
    question: "Which genes differ?",
    acceptance_criteria: ["Adjusted p-values reported"],
    constraints: ["Preserve contrasts"],
    caveats: ["Small cohort"],
    depends_on: ["T1S1"],
    resources: { cpu: 4, memoryGb: 8, gpuCount: 0 },
    track: "expression",
    step_type: "analysis",
};

describe("PlanStepDetailDialog", () => {
    test("composes every carried detail field", () => {
        const lines = planStepDetailLines(detailStep).join("\n");
        for (const expected of ["deseq2", "Which genes differ?", "Adjusted p-values", "Preserve contrasts", "Small cohort", "T1S1", "4 CPU", "8 GB"]) {
            expect(lines).toContain(expected);
        }
    });

    test("renders as a gallery-compatible read-only dialog", async () => {
        const frame = await renderFrame(() => <PlanStepDetailDialog step={detailStep} onClose={() => {}} />, { width: 100, height: 24 });
        expect(frame).toContain("T1S2");
        expect(frame).toContain("Which genes differ?");
    });
});
