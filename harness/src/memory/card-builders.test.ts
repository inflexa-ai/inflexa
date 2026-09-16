import { describe, expect, it } from "bun:test";

import { buildPresentationCardData } from "./card-builders.js";

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

        const spec = (card!.content as { spec: Record<string, unknown> }).spec;
        expect("title" in spec).toBe(false);
        expect(spec.legend).toEqual({ show: false });
        expect(spec.grid).toEqual({ top: "8%", bottom: "20%", left: "10%", right: "5%" });
        expect(spec.toolbox).toEqual({ right: 0, top: 0, feature: { saveAsImage: { type: "png", name: "de-genes" } } });
    });

    it("keys the id off the raw input, so normalization never moves a card's identity", () => {
        const input = { kind: "echart", title: "T", spec: { title: { text: "dup" }, series: [{ type: "line" }] } };
        const a = buildPresentationCardData(input);
        const b = buildPresentationCardData(structuredClone(input));

        expect(a!.id).toBe(b!.id);
        expect(a!.id).toMatch(/^pres-[0-9a-f]{16}$/);
    });

    it("carries a non-echart kind through untouched", () => {
        const card = buildPresentationCardData({ kind: "markdown", title: "Findings", body: "## Hello" });
        expect(card!.content).toEqual({ kind: "markdown", body: "## Hello" });
    });

    it("carries an echart without a spec through untouched (there is no spec to invent)", () => {
        const card = buildPresentationCardData({ kind: "echart", dataPath: "runs/run-a/step-1/output/de.csv" });
        expect(card!.content).toEqual({ kind: "echart", dataPath: "runs/run-a/step-1/output/de.csv" });
    });
});

describe("buildPresentationCardData — structure", () => {
    const url = "https://alphafold.ebi.ac.uk/files/AF-P38398-F1-model_v6.cif";

    it("normalizes an admitted AlphaFold URL into the derived source fields", () => {
        const card = buildPresentationCardData({ kind: "structure", title: "BRCA1", url });
        expect(card!.title).toBe("BRCA1");
        expect(card!.content).toEqual({ kind: "structure", format: "mmcif", url, provider: "alphafold", accession: "P38398", version: 6 });
    });

    it("refuses a URL the grammar does not admit — no card on the live path or on replay", () => {
        expect(buildPresentationCardData({ kind: "structure", url: "https://example.org/model.pdb" })).toBeNull();
        expect(buildPresentationCardData({ kind: "structure" })).toBeNull();
    });

    it("does not let a stray field of the flat tool input ride along", () => {
        const card = buildPresentationCardData({ kind: "structure", url, body: "## stray", spec: { series: [] } });
        expect(Object.keys(card!.content).sort()).toEqual(["accession", "format", "kind", "provider", "url", "version"]);
    });

    it("keys the id off the raw input and rebuilds identically from a clone", () => {
        const input = { kind: "structure", title: "BRCA1", url };
        const a = buildPresentationCardData(input);
        const b = buildPresentationCardData(structuredClone(input));
        expect(a).toEqual(b);
        expect(a!.id).toMatch(/^pres-[0-9a-f]{16}$/);
    });
});
