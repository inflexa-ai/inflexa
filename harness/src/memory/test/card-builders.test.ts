import { describe, expect, it } from "bun:test";

import { parseUnknownRecord } from "../../lib/unknown-containers.js";
import type { PlanRecord } from "../../state/index.js";
import { buildPresentationCardData, planCardOf, planPartOf } from "../card-builders.js";

function planDocument(title?: string) {
    return {
        title,
        analytical_narrative: "why",
        created_at: "2026-10-01T00:00:00.000Z",
        steps: [
            {
                id: "T1S1",
                name: "Normalize",
                track: "1",
                step_type: "analysis",
                question: "Which genes change?",
                acceptance_criteria: ["A counts table exists"],
                depends_on: [],
                status: "pending",
                maxSteps: 10,
                agent: "rna-seq",
            },
        ],
    };
}

function recordOf(overrides: Partial<PlanRecord> = {}): PlanRecord {
    return {
        planId: "pln-0000000b",
        plan: planDocument("Differential expression"),
        parentPlanId: null,
        supersededBy: null,
        createdAt: "2026-10-02T00:00:00.000Z",
        ...overrides,
    };
}

describe("planCardOf", () => {
    it("sets parentPlanId on the card of a revision", () => {
        expect(planCardOf(recordOf({ parentPlanId: "pln-0000000a" }))?.parentPlanId).toBe("pln-0000000a");
    });

    it("omits the parentPlanId key on the card of a first plan", () => {
        expect(planCardOf(recordOf())).not.toHaveProperty("parentPlanId");
    });

    it("lets a title override the plan title", () => {
        expect(planCardOf(recordOf(), "Shown")?.title).toBe("Shown");
        expect(planCardOf(recordOf())?.title).toBe("Differential expression");
    });

    it("gives null for a document that does not parse", () => {
        expect(planCardOf(recordOf({ plan: { steps: "no" } }))).toBeNull();
    });
});

describe("planPartOf", () => {
    it("gives the data-plan part of a stored revision", () => {
        const part = planPartOf(recordOf({ parentPlanId: "pln-0000000a" }));

        expect(part?.type).toBe("data-plan");
        expect(part?.planId).toBe("pln-0000000b");
        expect(part?.parentPlanId).toBe("pln-0000000a");
        expect(part?.title).toBe("Differential expression");
        expect(part?.steps?.map((step) => step.id)).toEqual(["T1S1"]);
    });

    it("gives null for a document that does not parse", () => {
        expect(planPartOf(recordOf({ plan: { steps: "no" } }))).toBeNull();
    });

    it("gives null when the part schema refuses the part", () => {
        expect(planPartOf(recordOf({ planId: "not-a-plan-id" }))).toBeNull();
    });
});

describe("buildPresentationCardData", () => {
    // The builder is the single construction site of a PresentationContent — the live `show_user`
    // emit and the reconstruct-on-read path both go through it, so normalizing here is what makes the
    // ECharts layout an invariant rather than a rule the model has to remember.
    it("normalizes an echart spec: strips the duplicate title, places the legend, injects grid + toolbox", () => {
        const card = buildPresentationCardData({
            kind: "echart",
            title: "DE Genes",
            spec: {
                title: { text: "DE Genes", subtext: "padj < 0.05" },
                xAxis: { type: "category", data: ["a", "b"] },
                yAxis: { type: "value" },
                series: [{ type: "bar" }],
            },
        });
        if (card === null) throw new Error("the card is absent");

        const spec = parseUnknownRecord(card.content.spec);
        if (spec === undefined) throw new Error("expected the card content record");
        expect("title" in spec).toBe(false);
        expect(spec.legend).toEqual({ show: false });
        expect(spec.grid).toEqual({ top: "8%", bottom: "20%", left: "10%", right: "5%" });
        expect(spec.toolbox).toEqual({ right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "de-genes" } } });
    });

    it("keys the id off the raw input, so normalization never moves a card's identity", () => {
        const input = { kind: "echart", title: "T", spec: { title: { text: "dup" }, series: [{ type: "line" }] } };
        const a = buildPresentationCardData(input);
        const b = buildPresentationCardData(structuredClone(input));
        if (b === null) throw new Error("the card is absent");

        expect(a?.id).toBe(b.id);
        expect(a?.id).toMatch(/^pres-[0-9a-f]{16}$/);
    });

    it("carries a non-echart kind through untouched", () => {
        const card = buildPresentationCardData({ kind: "markdown", title: "Findings", body: "## Hello" });
        expect(card?.content).toEqual({ kind: "markdown", body: "## Hello" });
    });

    it("carries an echart without a spec through untouched (there is no spec to invent)", () => {
        const card = buildPresentationCardData({ kind: "echart", dataPath: "runs/run-a/step-1/output/de.csv" });
        expect(card?.content).toEqual({ kind: "echart", dataPath: "runs/run-a/step-1/output/de.csv" });
    });
});

describe("buildPresentationCardData — structure", () => {
    const url = "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.cif";

    it("normalizes an admitted AlphaFold URL into the derived source fields", () => {
        const card = buildPresentationCardData({ kind: "structure", title: "BRCA1", url });
        expect(card?.title).toBe("BRCA1");
        expect(card?.content).toEqual({ kind: "structure", format: "mmcif", url, provider: "alphafold", accession: "P38398", version: 6 });
    });

    it("refuses a URL the grammar does not admit — no card on the live path or on replay", () => {
        expect(buildPresentationCardData({ kind: "structure", url: "https://example.org/model.pdb" })).toBeNull();
        expect(buildPresentationCardData({ kind: "structure" })).toBeNull();
    });

    it("does not let a stray field of the flat tool input ride along", () => {
        const card = buildPresentationCardData({ kind: "structure", url, body: "## stray", spec: { series: [] } });
        expect(Object.keys(card?.content ?? {}).sort()).toEqual(["accession", "format", "kind", "provider", "url", "version"]);
    });

    it("keys the id off the raw input and rebuilds identically from a clone", () => {
        const input = { kind: "structure", title: "BRCA1", url };
        const a = buildPresentationCardData(input);
        const b = buildPresentationCardData(structuredClone(input));
        expect(a).toEqual(b);
        expect(a?.id).toMatch(/^pres-[0-9a-f]{16}$/);
    });
});
