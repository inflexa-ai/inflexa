import { describe, expect, it } from "bun:test";

import type { ClaimView, Grounding } from "../../schemas/workflow-state.js";
import type { StepTemplateArtifact } from "../../state/artifacts.js";
import { MAX_METHODS_CLAIMS, buildStepMethods, claimViewsOfGrounding, renderDeparture } from "../step-methods.js";

const SNAPSHOT = "sha256:a559d904";

const GROUNDING: Grounding = {
    status: "grounded",
    snapshot: SNAPSHOT,
    claims: ["R-0028@d560", "R-0056@d560"],
    template: "tpl-edger-ql@1.8.0",
    reason: "edgeR QL per R-0028",
};

function view(id: string, overrides: Partial<ClaimView> = {}): ClaimView {
    return {
        id,
        snapshot: SNAPSHOT,
        title: `The title of ${id}`,
        statement: `The statement of ${id}`,
        strength: "consensus",
        evidence: [],
        license: "CC-BY-4.0",
        ...overrides,
    };
}

const SCRIPT: StepTemplateArtifact = {
    path: "runs/run-1/T1S2/work/tpl-edger-ql.R",
    template: {
        template: "tpl-edger-ql@1.8.0",
        label: "edgeR quasi-likelihood F-test",
        method: { id: "M-0003", label: "edgeR QL" },
        snapshot: SNAPSHOT,
        environmentMatch: "exact",
    },
};

describe("buildStepMethods", () => {
    it("names the claims of the grounding with their views, the sources of their evidence, and the rendered scripts", () => {
        const { methods, sources } = buildStepMethods({
            grounding: GROUNDING,
            claimViews: [
                view("R-0028@d560", { evidence: [{ doi: "10.1/a", title: "Paper A", year: 2016, direction: "supports" }] }),
                view("R-0056@d560", {
                    evidence: [
                        { doi: "10.1/A", title: "Paper A again", year: 2016, direction: "supports" },
                        { title: "No identifier", year: 2020, direction: "supports" },
                    ],
                }),
            ],
            templates: [SCRIPT],
            stepDir: "runs/run-1/T1S2",
        });

        expect(methods?.grounding).toBe("grounded");
        expect(methods?.snapshot).toBe(SNAPSHOT);
        expect(methods?.claims).toEqual([
            { id: "R-0028@d560", title: "The title of R-0028@d560", strength: "consensus" },
            { id: "R-0056@d560", title: "The title of R-0056@d560", strength: "consensus" },
        ]);
        // One source for each DOI in any case; a source with no identifier is not a source.
        expect(sources.map((source) => source.doi)).toEqual(["10.1/a"]);
        expect(methods?.templates).toEqual([
            {
                id: "tpl-edger-ql",
                version: "1.8.0",
                label: "edgeR quasi-likelihood F-test",
                method: { id: "M-0003", label: "edgeR QL" },
                environmentMatch: "exact",
                script: "work/tpl-edger-ql.R",
            },
        ]);
        expect(methods?.license).toBe("CC-BY-4.0");
    });

    it("gives a claim with no view by its id, and only the views of the release of the grounding", () => {
        const { methods } = buildStepMethods({
            grounding: GROUNDING,
            claimViews: [view("R-0028@d560", { snapshot: "sha256:other" })],
            templates: [],
            stepDir: "runs/run-1/T1S2",
        });

        expect(methods?.claims).toEqual([
            { id: "R-0028@d560", title: undefined, strength: undefined },
            { id: "R-0056@d560", title: undefined, strength: undefined },
        ]);
        expect(methods?.templates).toEqual([]);
    });

    it("gives no methods for a step with no grounding and no rendered script", () => {
        expect(buildStepMethods({ claimViews: [], templates: [], stepDir: "runs/run-1/T1S1" })).toEqual({ sources: [] });
    });

    it("gives the methods of a step with no grounding from its rendered scripts", () => {
        const { methods } = buildStepMethods({ claimViews: [], templates: [SCRIPT], stepDir: "runs/run-1/T1S2" });

        expect(methods?.grounding).toBeUndefined();
        expect(methods?.snapshot).toBe(SNAPSHOT);
        expect(methods?.templates.map((template) => template.id)).toEqual(["tpl-edger-ql"]);
    });

    it("bounds the claims and counts the tail", () => {
        const claims = Array.from({ length: MAX_METHODS_CLAIMS + 3 }, (_, index) => `R-${String(index).padStart(4, "0")}@d560`);
        const { methods } = buildStepMethods({ grounding: { ...GROUNDING, claims }, claimViews: [], templates: [], stepDir: "runs/run-1/T1S2" });

        expect(methods?.claims).toHaveLength(MAX_METHODS_CLAIMS);
        expect(methods?.claimsOmitted).toBe(3);
    });

    it("carries the departures of the grounding", () => {
        const departure = { rule: "R-0028@d560", setting: "test", value: "lrt", reason: "a nested design" };
        const { methods } = buildStepMethods({
            grounding: { ...GROUNDING, departures: [departure] },
            claimViews: [],
            templates: [],
            stepDir: "runs/run-1/T1S2",
        });

        expect(methods?.departures).toEqual([departure]);
        expect(renderDeparture(departure)).toBe('R-0028@d560: `test` = "lrt". a nested design');
    });
});

describe("claimViewsOfGrounding", () => {
    it("selects the views of the claims of the grounding, in the order of the grounding", () => {
        const views = [view("R-0056@d560"), view("R-0028@d560"), view("R-0099@d560")];
        expect(claimViewsOfGrounding(GROUNDING, views).map((entry) => entry.id)).toEqual(["R-0028@d560", "R-0056@d560"]);
        expect(claimViewsOfGrounding(undefined, views)).toEqual([]);
    });
});
