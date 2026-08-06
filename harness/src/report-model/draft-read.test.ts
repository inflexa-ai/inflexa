import { describe, expect, it } from "bun:test";

import type { ArtifactFileReference, ArtifactTableReference, ArtifactValueReference, CitationReference } from "../contracts/report-reference.js";
import type { DraftDocument } from "./draft.js";
import { buildOutline, readBlock } from "./draft-read.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;

function tableReference(): ArtifactTableReference {
    return { kind: "artifact-table", path: OUTPUT_PATH, hash: OUTPUT_HASH };
}

function fileReference(): ArtifactFileReference {
    return { kind: "artifact-file", path: "runs/run-1/step-a/figures/volcano.png", hash: OUTPUT_HASH };
}

function citationReference(): CitationReference {
    return { kind: "citation", idKind: "pmid", id: "12345", raw: "A source." };
}

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

    it("clips a long claim prose to a label of exactly 80 characters, and marks the clip", () => {
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
        expect(claimEntry?.label).toBe(`${"x".repeat(79)}…`);
    });

    it("clips a long title, a long caption, and a long note", () => {
        const long = "y".repeat(120);
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: long,
                    blocks: [
                        { kind: "figure", id: "f1", binding: fileReference(), caption: long },
                        { kind: "table", id: "tb1", title: long, binding: tableReference() },
                        { kind: "citation", id: "cit1", binding: citationReference(), note: long },
                        { kind: "metric", id: "m9", label: long, value: valueReference() },
                    ],
                },
            ],
        };
        for (const entry of buildOutline(draft)) {
            expect([...entry.label].length).toBe(80);
            expect(entry.label.endsWith("…")).toBe(true);
        }
    });

    it("never splits an astral character across the clip boundary", () => {
        // The astral character sits at UTF-16 offsets 78 and 79, thus a slice by code unit would keep the
        // high surrogate alone.
        const prose = `${"y".repeat(78)}\u{1F600}${"z".repeat(50)}`;
        const draft: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose } }] }],
        };
        const label = buildOutline(draft).find((entry) => entry.id === "t1")?.label ?? "";
        expect(label).toBe(`${"y".repeat(78)}\u{1F600}…`);
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label)).toBe(false);
    });

    it("keeps a label that is exactly the clip length whole, with no marker", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "z".repeat(80), blocks: [] }],
        };
        expect(buildOutline(draft)[0].label).toBe("z".repeat(80));
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

    it("reads a section as its own fields and the id of each child, and never the subtree", () => {
        const found = readBlock(nestedDraft, "s1");
        expect(found).toEqual({ kind: "section", id: "s1", title: "Intro", childIds: ["t1", "s1a"] });
        // The grandchild rides in the outline, thus a read of a top-level section never returns the tree.
        expect(JSON.stringify(found)).not.toContain("Coverage");
    });

    it("gives undefined for an id that no block holds", () => {
        expect(readBlock(nestedDraft, "unknown")).toBeUndefined();
    });
});
