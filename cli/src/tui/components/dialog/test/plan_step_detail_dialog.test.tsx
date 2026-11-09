import { describe, expect, test } from "bun:test";
import { renderFrame } from "../../../../test_support/tui.ts";

import { MAX_GROUNDING_ITEMS, PlanStepDetailDialog, planStepDetailLines } from "../plan_step_detail_dialog.tsx";
import type { PlanCardGroundingView, PlanCardStepView } from "../../../../types/session.ts";

const detailStep: PlanCardStepView = {
    id: "T1S2",
    name: "Fit DE model",
    agent: "deseq2",
    question: "Which genes differ?",
    acceptance_criteria: ["Adjusted p-values reported"],
    constraints: ["Preserve contrasts"],
    caveats: ["Small cohort"],
    depends_on: ["T1S1"],
    track: "expression",
    step_type: "analysis",
};

describe("PlanStepDetailDialog", () => {
    test("composes every carried detail field", () => {
        const lines = planStepDetailLines(detailStep).join("\n");
        for (const expected of ["deseq2", "Which genes differ?", "Adjusted p-values", "Preserve contrasts", "Small cohort", "T1S1"]) {
            expect(lines).toContain(expected);
        }
    });

    test("shows the grounding of a grounded step: the release, the template, the reason, the rules, the settings, and the sources", () => {
        const grounding: PlanCardGroundingView = {
            status: "grounded",
            snapshot: "sha256:71ac",
            template: "tpl-edger-ql@1.8.0",
            reason: "edgeR per R-0028",
            rules: [
                { id: "R-0028@d560", title: "Use the QL F-test", strength: "consensus" },
                { id: "R-0099@0000", title: "", strength: "" },
            ],
            settings: [{ step: "differential_expression", name: "fdr", value: "0.05", source: "doi:10.1093/bioinformatics/btw014" }],
            departures: [],
            sources: [
                { title: "edgeR QL", year: 2016, ref: "doi:10.1093/bioinformatics/btw014" },
                { title: "A manual", year: 2020, ref: "" },
            ],
        };

        const lines = planStepDetailLines({ ...detailStep, grounding });

        for (const expected of [
            "grounding: grounded · knowledge release sha256:71ac",
            "template: tpl-edger-ql@1.8.0",
            "  edgeR per R-0028",
            "  - R-0028@d560 (consensus) Use the QL F-test",
            "  - R-0099@0000",
            "  - differential_expression.fdr = 0.05 (doi:10.1093/bioinformatics/btw014)",
            "  - edgeR QL (2016), doi:10.1093/bioinformatics/btw014",
            "  - A manual (2020)",
        ]) {
            expect(lines).toContain(expected);
        }
    });

    test("shows each departure of a grounded step with its rule, its setting, the value of the plan, and the reason", () => {
        const grounding: PlanCardGroundingView = {
            status: "grounded",
            snapshot: "sha256:71ac",
            template: "",
            reason: "r",
            rules: [],
            settings: [],
            departures: [
                { rule: "R-0001@e7d0", change: "value", setting: "n_top_genes_pca", value: "364", reason: "the panel holds 364 targets" },
                { rule: "R-0001@e7d0", change: "value", setting: "covariates", value: "[]", reason: "the design has no covariate" },
                { rule: "R-0001@e7d0", change: "not_applied", setting: "lfc_shrink", value: "", reason: "the plan reports the unshrunk fold changes" },
                { rule: "R-0147@3c1d", change: "left_out", setting: "", value: "", reason: "the inputs hold no amplicon sequence" },
            ],
            sources: [],
        };

        const lines = planStepDetailLines({ ...detailStep, grounding });

        expect(lines).toContain("departures from the rules:");
        expect(lines).toContain("  - R-0001@e7d0: n_top_genes_pca = 364. the panel holds 364 targets");
        expect(lines).toContain("  - R-0001@e7d0: covariates = []. the design has no covariate");
        expect(lines).toContain("  - R-0001@e7d0: lfc_shrink not applied. the plan reports the unshrunk fold changes");
        expect(lines).toContain("  - R-0147@3c1d: the inputs hold no amplicon sequence");
    });

    test("shows no departure section for a step with no departures", () => {
        const grounding: PlanCardGroundingView = {
            status: "grounded",
            snapshot: "sha256:71ac",
            template: "",
            reason: "r",
            rules: [],
            settings: [],
            departures: [],
            sources: [],
        };

        expect(planStepDetailLines({ ...detailStep, grounding })).not.toContain("departures from the rules:");
    });

    test("bounds the sources of a step, and names the count of the rest", () => {
        const sources = Array.from({ length: MAX_GROUNDING_ITEMS + 3 }, (_, i) => ({ title: `Paper ${i}`, year: 2020, ref: "" }));
        const grounding: PlanCardGroundingView = {
            status: "grounded",
            snapshot: "sha256:71ac",
            template: "",
            reason: "r",
            rules: [],
            settings: [],
            departures: [],
            sources,
        };

        const lines = planStepDetailLines({ ...detailStep, grounding });

        expect(lines).toContain(`  - Paper ${MAX_GROUNDING_ITEMS - 1} (2020)`);
        expect(lines).not.toContain(`  - Paper ${MAX_GROUNDING_ITEMS} (2020)`);
        expect(lines).toContain("  - (+3 more)");
    });

    test("shows no grounding section for a step with no grounding", () => {
        expect(planStepDetailLines(detailStep).join("\n")).not.toContain("grounding:");
    });

    test("renders as a gallery-compatible read-only dialog", async () => {
        const frame = await renderFrame(() => <PlanStepDetailDialog step={detailStep} onClose={() => {}} />, { width: 100, height: 24 });
        expect(frame).toContain("T1S2");
        expect(frame).toContain("Which genes differ?");
    });
});
