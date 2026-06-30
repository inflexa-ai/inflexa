import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPreviewCardData } from "./card-builders.js";

const ANALYSIS = "analysis-preview-1";
const PREVIEW = "prv-abc12345";

let sessions: string;

/** Write a preview tree under `previews/{analysis}/{preview}/`. */
async function seedPreview(opts: { versions: number[]; meta?: { title?: string; format?: "html" | "pdf" }; previewId?: string }): Promise<void> {
    const root = join(sessions, "previews", ANALYSIS, opts.previewId ?? PREVIEW);
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

        const card = await buildPreviewCardData(sessions, ANALYSIS, {});

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

        const card = await buildPreviewCardData(sessions, ANALYSIS, {
            previewId: "prv-older00",
        });

        expect(card?.previewId).toBe("prv-older00");
        expect(card?.version).toBe(1);
    });

    it("keys the id off previewId only, so every version rebuilds one card", async () => {
        await seedPreview({ versions: [1, 2] });
        const v1 = await buildPreviewCardData(sessions, ANALYSIS, {});
        await seedPreview({ versions: [1, 2, 3] });
        const v3 = await buildPreviewCardData(sessions, ANALYSIS, {});

        expect(v1?.id).toBe(v3!.id);
    });

    it("prefers the explicit title/format over the meta file", async () => {
        await seedPreview({
            versions: [1],
            meta: { title: "Meta Title", format: "html" },
        });

        const card = await buildPreviewCardData(sessions, ANALYSIS, {
            title: "Override",
            format: "pdf",
        });

        expect(card?.title).toBe("Override");
        expect(card?.format).toBe("pdf");
    });

    it("defaults title to 'Report' and format to 'html' when meta is absent", async () => {
        await seedPreview({ versions: [1] });

        const card = await buildPreviewCardData(sessions, ANALYSIS, {});

        expect(card?.title).toBe("Report");
        expect(card?.format).toBe("html");
    });

    it("returns null when the analysis has no previews", async () => {
        expect(await buildPreviewCardData(sessions, ANALYSIS, {})).toBeNull();
    });

    it("returns null when a preview dir exists but has no version dirs", async () => {
        await mkdir(join(sessions, "previews", ANALYSIS, PREVIEW), {
            recursive: true,
        });
        expect(await buildPreviewCardData(sessions, ANALYSIS, {})).toBeNull();
    });
});
