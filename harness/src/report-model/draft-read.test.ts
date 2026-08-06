import { describe, expect, it } from "bun:test";

import type { ArtifactValueReference } from "../contracts/report-reference.js";
import type { DraftDocument } from "./draft.js";
import { buildOutline, readBlock } from "./draft-read.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;

function valueReference(): ArtifactValueReference {
    return {
        kind: "artifact-value",
        path: OUTPUT_PATH,
        hash: OUTPUT_HASH,
        locator: { column: "padj", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
    };
}

// A draft with two top-level sections, and one nested section inside the first. It exercises the order,
// the depth, and the label of each block kind.
const nestedDraft: DraftDocument = {
    title: "Report",
    sections: [
        {
            kind: "section",
            id: "s1",
            title: "Intro",
            blocks: [
                { kind: "text", id: "t1", content: { prose: "Body text." } },
                {
                    kind: "section",
                    id: "s1a",
                    title: "Background",
                    blocks: [{ kind: "metric", id: "m1", label: "Coverage", value: valueReference() }],
                },
            ],
        },
        {
            kind: "section",
            id: "s2",
            title: "Results",
            blocks: [{ kind: "text", id: "t2", content: { prose: "More text." } }],
        },
    ],
};

describe("buildOutline", () => {
    it("gives one entry for each block in document order, with the depth and the label", () => {
        const outline = buildOutline(nestedDraft);
        expect(outline).toEqual([
            { id: "s1", kind: "section", depth: 0, label: "Intro" },
            { id: "t1", kind: "text", depth: 1, label: "Body text." },
            { id: "s1a", kind: "section", depth: 1, label: "Background" },
            { id: "m1", kind: "metric", depth: 2, label: "Coverage" },
            { id: "s2", kind: "section", depth: 0, label: "Results" },
            { id: "t2", kind: "text", depth: 1, label: "More text." },
        ]);
    });

    it("clips a long claim prose to a label of exactly 80 characters", () => {
        const longProse = "x".repeat(120);
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "claim", id: "c1", content: { prose: longProse }, bindings: [valueReference()] }],
                },
            ],
        };
        const claimEntry = buildOutline(draft).find((entry) => entry.id === "c1");
        expect(claimEntry?.label.length).toBe(80);
        expect(claimEntry?.label).toBe("x".repeat(80));
    });

    it("carries no binding field on an outline entry", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "metric", id: "m1", label: "Coverage", value: valueReference() }],
                },
            ],
        };
        const metricEntry = buildOutline(draft).find((entry) => entry.id === "m1");
        expect(Object.keys(metricEntry ?? {}).sort()).toEqual(["depth", "id", "kind", "label"]);
    });
});

describe("readBlock", () => {
    it("reads an atom in full, with its binding", () => {
        const found = readBlock(nestedDraft, "m1");
        expect(found).toEqual({ kind: "metric", id: "m1", label: "Coverage", value: valueReference() });
    });

    it("reads a section with its children", () => {
        const found = readBlock(nestedDraft, "s1");
        expect(found?.kind).toBe("section");
        if (found?.kind === "section") {
            expect(found.blocks.map((block) => block.id)).toEqual(["t1", "s1a"]);
        }
    });

    it("gives undefined for an id that no block holds", () => {
        expect(readBlock(nestedDraft, "unknown")).toBeUndefined();
    });
});
