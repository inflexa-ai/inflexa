import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPresentationCardData, buildPreviewCardData } from "./card-builders.js";

const ANALYSIS = "analysis-preview-1";
const PREVIEW = "prv-abc12345";

let sessions: string;
let workspaceRoot: string;

/** Write a preview tree under `{workspaceRoot}/previews/{preview}/`. */
async function seedPreview(opts: { versions: number[]; meta?: { title?: string; format?: "html" | "pdf" }; previewId?: string }): Promise<void> {
    const root = join(workspaceRoot, "previews", opts.previewId ?? PREVIEW);
    for (const v of opts.versions) {
        await mkdir(join(root, `v${v}`), { recursive: true });
        await writeFile(join(root, `v${v}`, "index.html"), "<html></html>");
    }
    if (opts.meta) {
        await writeFile(join(root, "preview-meta.json"), JSON.stringify(opts.meta), "utf8");
    }
}

beforeEach(async () => {
    sessions = await mkdtemp(join(tmpdir(), "cortex-preview-"));
    workspaceRoot = join(sessions, ANALYSIS);
});

afterEach(async () => {
    await rm(sessions, { recursive: true, force: true });
});

describe("buildPreviewCardData", () => {
    it("reconstructs a card at the latest version with meta title/format", async () => {
        await seedPreview({
            versions: [1, 2, 3],
            meta: { title: "Tirzepatide Proteomics", format: "html" },
        });

        const card = await buildPreviewCardData(workspaceRoot, {});

        expect(card).toEqual({
            id: expect.stringMatching(/^prev-[0-9a-f]{16}$/),
            previewId: PREVIEW,
            version: 3,
            title: "Tirzepatide Proteomics",
            previewPath: "v3/index.html",
            format: "html",
        });
    });

    it("resolves a specific previewId from the input over the latest-on-disk", async () => {
        await seedPreview({ versions: [1], previewId: "prv-older00" });
        await seedPreview({ versions: [1, 2], previewId: "prv-newer00" });

        const card = await buildPreviewCardData(workspaceRoot, {
            previewId: "prv-older00",
        });

        expect(card?.previewId).toBe("prv-older00");
        expect(card?.version).toBe(1);
    });

    it("keys the id off previewId only, so every version rebuilds one card", async () => {
        await seedPreview({ versions: [1, 2] });
        const v1 = await buildPreviewCardData(workspaceRoot, {});
        await seedPreview({ versions: [1, 2, 3] });
        const v3 = await buildPreviewCardData(workspaceRoot, {});

        expect(v1?.id).toBe(v3!.id);
    });

    it("prefers the explicit title/format over the meta file", async () => {
        await seedPreview({
            versions: [1],
            meta: { title: "Meta Title", format: "html" },
        });

        const card = await buildPreviewCardData(workspaceRoot, {
            title: "Override",
            format: "pdf",
        });

        expect(card?.title).toBe("Override");
        expect(card?.format).toBe("pdf");
    });

    it("defaults title to 'Report' and format to 'html' when meta is absent", async () => {
        await seedPreview({ versions: [1] });

        const card = await buildPreviewCardData(workspaceRoot, {});

        expect(card?.title).toBe("Report");
        expect(card?.format).toBe("html");
    });

    it("returns null when the analysis has no previews", async () => {
        expect(await buildPreviewCardData(workspaceRoot, {})).toBeNull();
    });

    it("returns null when a preview dir exists but has no version dirs", async () => {
        await mkdir(join(workspaceRoot, "previews", PREVIEW), {
            recursive: true,
        });
        expect(await buildPreviewCardData(workspaceRoot, {})).toBeNull();
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
