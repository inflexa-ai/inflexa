import { describe, expect, it } from "bun:test";

import type { ArtifactTableReference, ArtifactValueReference } from "../contracts/report-reference.js";
import { addBlock, changeBlock, moveBlock, removeBlock } from "./draft-operations.js";
import type { DraftBlock, DraftDocument } from "./draft.js";
import type { ReportSnapshot } from "./reference-resolver.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;
// The output of a later run. The snapshot froze before that run, thus it holds no entry for this path.
const ABSENT_PATH = "runs/run-2/step-a/output/later.csv";
const ABSENT_HASH = `sha256:${"3".repeat(64)}`;

const snapshot: ReportSnapshot = {
    artifacts: {
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
    },
};

function valueReference(path = OUTPUT_PATH, hash = OUTPUT_HASH): ArtifactValueReference {
    return { kind: "artifact-value", path, hash, locator: { column: "padj", rowFilter: { column: "gene", op: "eq", value: "TP53" } } };
}

function tableReference(path = OUTPUT_PATH, hash = OUTPUT_HASH): ArtifactTableReference {
    return { kind: "artifact-table", path, hash };
}

/** A draft with two sections. The first holds a text block and a metric, and the second is empty. */
function baseDraft(): DraftDocument {
    return {
        title: "Report",
        sections: [
            {
                kind: "section",
                id: "sec-1",
                title: "First",
                blocks: [
                    { kind: "text", id: "text-1", content: { prose: "Intro." } },
                    { kind: "metric", id: "metric-1", label: "padj", value: valueReference() },
                ],
            },
            { kind: "section", id: "sec-2", title: "Second", blocks: [] },
        ],
    };
}

/** A draft with a table, a chart, and a metric, all in one section. */
function chartDraft(): DraftDocument {
    return {
        title: "Report",
        sections: [
            {
                kind: "section",
                id: "sec-1",
                title: "First",
                blocks: [
                    { kind: "table", id: "table-1", binding: tableReference() },
                    { kind: "chart", id: "chart-1", binding: tableReference(), chartType: "bar", encoding: { x: "gene", y: "padj" } },
                    { kind: "metric", id: "metric-1", label: "padj", value: valueReference() },
                ],
            },
        ],
    };
}

/** A draft with a nested section. `inner` is a child of `outer`, and `outer` also holds a metric. */
function nestedDraft(): DraftDocument {
    return {
        title: "Report",
        sections: [
            {
                kind: "section",
                id: "outer",
                title: "Outer",
                blocks: [
                    { kind: "section", id: "inner", title: "Inner", blocks: [{ kind: "text", id: "text-1", content: { prose: "Deep." } }] },
                    { kind: "metric", id: "metric-1", label: "padj", value: valueReference() },
                ],
            },
            { kind: "section", id: "sec-2", title: "Second", blocks: [] },
        ],
    };
}

/** Find a block by its id anywhere in the document. */
function findById(document: DraftDocument, id: string): DraftBlock | undefined {
    const search = (blocks: DraftBlock[]): DraftBlock | undefined => {
        for (const block of blocks) {
            if (block.id === id) {
                return block;
            }
            if (block.kind === "section") {
                const found = search(block.blocks);
                if (found !== undefined) {
                    return found;
                }
            }
        }
        return undefined;
    };
    return search(document.sections);
}

describe("addBlock", () => {
    it("lands an atom at the end of a section", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const landed = addBlock(
            draft,
            { block: { kind: "metric", id: "metric-2", label: "count", value: valueReference() }, destination: { parentId: "sec-2" } },
            snapshot,
        )._unsafeUnwrap();

        // The core returns a new value, thus the landing does not alias the input.
        expect(landed).not.toBe(draft);
        expect(findById(landed, "metric-2")).toBeDefined();
        expect(draft).toEqual(before);
    });

    it("lands an atom at the end of a section that already holds children", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const landed = addBlock(
            draft,
            { block: { kind: "text", id: "text-2", content: { prose: "Tail." } }, destination: { parentId: "sec-1" } },
            snapshot,
        )._unsafeUnwrap();

        expect(landed.sections[0].blocks.map((block) => block.id)).toEqual(["text-1", "metric-1", "text-2"]);
        expect(draft).toEqual(before);
    });

    it("lands a section that carries children, and covers each child", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const payload = {
            kind: "section",
            id: "new-sec",
            title: "New",
            blocks: [
                { kind: "text", id: "child-a", content: { prose: "A." } },
                { kind: "metric", id: "child-b", label: "m", value: valueReference() },
            ],
        };
        const landed = addBlock(draft, { block: payload, destination: { place: "end" } }, snapshot)._unsafeUnwrap();

        expect(findById(landed, "new-sec")).toBeDefined();
        expect(findById(landed, "child-a")).toBeDefined();
        expect(findById(landed, "child-b")).toBeDefined();
        expect(draft).toEqual(before);
    });

    it("lands a block before an anchor", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const landed = addBlock(
            draft,
            { block: { kind: "text", id: "text-0", content: { prose: "Lead." } }, destination: { place: { before: "text-1" } } },
            snapshot,
        )._unsafeUnwrap();

        expect(landed.sections[0].blocks.map((block) => block.id)).toEqual(["text-0", "text-1", "metric-1"]);
        expect(draft).toEqual(before);
    });

    it("refuses an atom at the root with atom-at-root", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "chart", id: "chart-x", binding: tableReference(), chartType: "pie", encoding: {} } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("atom-at-root");
        expect(draft).toEqual(before);
    });

    it("refuses an unknown parent with unknown-target", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "text", id: "text-x", content: { prose: "X." } }, destination: { parentId: "ghost" } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });

    it("refuses an atom parent with not-a-section", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "text", id: "text-x", content: { prose: "X." } }, destination: { parentId: "metric-1" } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("not-a-section");
        expect(draft).toEqual(before);
    });

    it("refuses an anchor that disagrees with a named parent with unknown-target", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "text", id: "text-x", content: { prose: "X." } }, destination: { parentId: "sec-2", place: { after: "text-1" } } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });

    it("refuses a malformed block with malformed-block", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "text", id: "text-x", content: { prose: "X.", extra: true } }, destination: { parentId: "sec-2" } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("malformed-block");
        expect(failure.detail.length).toBeGreaterThan(0);
        expect(draft).toEqual(before);
    });

    it("refuses a duplicate id with duplicate-id", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "text", id: "text-1", content: { prose: "Clash." } }, destination: { parentId: "sec-2" } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("duplicate-id");
        expect(draft).toEqual(before);
    });

    it("refuses a duplicate id inside a section payload with duplicate-id", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const payload = {
            kind: "section",
            id: "new-sec",
            title: "New",
            blocks: [
                { kind: "text", id: "dup", content: { prose: "A." } },
                { kind: "text", id: "dup", content: { prose: "B." } },
            ],
        };
        const failure = addBlock(draft, { block: payload, destination: { place: "end" } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("duplicate-id");
        expect(draft).toEqual(before);
    });

    it("refuses an unresolvable reference with unresolved-reference, and carries it", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = addBlock(
            draft,
            { block: { kind: "metric", id: "metric-x", label: "m", value: valueReference(ABSENT_PATH, ABSENT_HASH) }, destination: { parentId: "sec-2" } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("unresolved-reference");
        if (failure.reason === "unresolved-reference") {
            expect(failure.unresolved).toHaveLength(1);
            expect(failure.unresolved[0].reason).toBe("artifact-missing");
        }
        expect(draft).toEqual(before);
    });

    it("refuses an unresolvable reference inside a child with unresolved-reference", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const payload = {
            kind: "section",
            id: "new-sec",
            title: "New",
            blocks: [{ kind: "metric", id: "child-b", label: "m", value: valueReference(ABSENT_PATH, ABSENT_HASH) }],
        };
        const failure = addBlock(draft, { block: payload, destination: { place: "end" } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("unresolved-reference");
        expect(draft).toEqual(before);
    });
});

describe("changeBlock", () => {
    it("lands one field change on a chart, and keeps the id", () => {
        const draft = chartDraft();
        const before = structuredClone(draft);
        const landed = changeBlock(
            draft,
            { targetId: "chart-1", block: { kind: "chart", binding: tableReference(), chartType: "pie", encoding: { x: "gene", y: "padj" } } },
            snapshot,
        )._unsafeUnwrap();

        const changed = findById(landed, "chart-1");
        expect(changed?.kind).toBe("chart");
        if (changed?.kind === "chart") {
            expect(changed.chartType).toBe("pie");
        }
        expect(draft).toEqual(before);
    });

    it("lands an atom kind change from a table to a chart", () => {
        const draft = chartDraft();
        const before = structuredClone(draft);
        const landed = changeBlock(
            draft,
            { targetId: "table-1", block: { kind: "chart", binding: tableReference(), chartType: "line", encoding: { x: "gene", y: "padj" } } },
            snapshot,
        )._unsafeUnwrap();

        expect(findById(landed, "table-1")?.kind).toBe("chart");
        expect(draft).toEqual(before);
    });

    it("keeps the target id when the atom payload carries a different id", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const landed = changeBlock(
            draft,
            { targetId: "metric-1", block: { kind: "metric", id: "other-id", label: "count", value: valueReference() } },
            snapshot,
        )._unsafeUnwrap();

        expect(findById(landed, "metric-1")?.kind).toBe("metric");
        expect(findById(landed, "other-id")).toBeUndefined();
        expect(draft).toEqual(before);
    });

    it("lands a section retitle, and keeps the children", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const section = findById(changeBlock(draft, { targetId: "sec-1", title: "Renamed" }, snapshot)._unsafeUnwrap(), "sec-1");

        expect(section?.kind).toBe("section");
        if (section?.kind === "section") {
            expect(section.title).toBe("Renamed");
            expect(section.blocks.map((block) => block.id)).toEqual(["text-1", "metric-1"]);
        }
        expect(draft).toEqual(before);
    });

    it("refuses an unknown target with unknown-target", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = changeBlock(draft, { targetId: "ghost", title: "X" }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });

    it("refuses a section payload for an atom target with payload-kind-mismatch", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = changeBlock(draft, { targetId: "metric-1", title: "X" }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("payload-kind-mismatch");
        expect(draft).toEqual(before);
    });

    it("refuses an atom payload for a section target with payload-kind-mismatch", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = changeBlock(draft, { targetId: "sec-1", block: { kind: "text", content: { prose: "X." } } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("payload-kind-mismatch");
        expect(draft).toEqual(before);
    });

    it("refuses a malformed atom payload with malformed-block", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = changeBlock(
            draft,
            { targetId: "metric-1", block: { kind: "metric", label: "m", value: valueReference(), extra: true } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("malformed-block");
        expect(draft).toEqual(before);
    });

    it("refuses an unresolvable reference in the new atom with unresolved-reference", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = changeBlock(
            draft,
            { targetId: "metric-1", block: { kind: "metric", label: "m", value: valueReference(ABSENT_PATH, ABSENT_HASH) } },
            snapshot,
        )._unsafeUnwrapErr();

        expect(failure.reason).toBe("unresolved-reference");
        expect(draft).toEqual(before);
    });
});

describe("removeBlock", () => {
    it("lands the removal of a section, and takes its subtree", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const landed = removeBlock(draft, { targetId: "inner" }, snapshot)._unsafeUnwrap();

        expect(findById(landed, "inner")).toBeUndefined();
        expect(findById(landed, "text-1")).toBeUndefined();
        expect(draft).toEqual(before);
    });

    it("lands the removal of the last child, and keeps the empty section", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const afterFirst = removeBlock(draft, { targetId: "text-1" }, snapshot)._unsafeUnwrap();
        const section = findById(removeBlock(afterFirst, { targetId: "metric-1" }, snapshot)._unsafeUnwrap(), "sec-1");

        expect(section?.kind).toBe("section");
        if (section?.kind === "section") {
            expect(section.blocks).toHaveLength(0);
        }
        expect(draft).toEqual(before);
    });

    it("refuses an unknown id with unknown-target", () => {
        const draft = baseDraft();
        const before = structuredClone(draft);
        const failure = removeBlock(draft, { targetId: "ghost" }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });
});

describe("moveBlock", () => {
    it("lands a move between sections", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const landed = moveBlock(draft, { targetId: "metric-1", destination: { parentId: "sec-2" } }, snapshot)._unsafeUnwrap();

        const outer = findById(landed, "outer");
        const second = findById(landed, "sec-2");
        expect(outer?.kind === "section" && outer.blocks.map((block) => block.id)).toEqual(["inner"]);
        expect(second?.kind === "section" && second.blocks.map((block) => block.id)).toEqual(["metric-1"]);
        expect(draft).toEqual(before);
    });

    it("lands a same-section move after an anchor that sits later", () => {
        const draft = chartDraft();
        const before = structuredClone(draft);
        const landed = moveBlock(draft, { targetId: "table-1", destination: { place: { after: "chart-1" } } }, snapshot)._unsafeUnwrap();

        const section = findById(landed, "sec-1");
        expect(section?.kind === "section" && section.blocks.map((block) => block.id)).toEqual(["chart-1", "table-1", "metric-1"]);
        expect(draft).toEqual(before);
    });

    it("lands a same-section move before the first child", () => {
        const draft = chartDraft();
        const before = structuredClone(draft);
        const landed = moveBlock(draft, { targetId: "metric-1", destination: { place: { before: "table-1" } } }, snapshot)._unsafeUnwrap();

        const section = findById(landed, "sec-1");
        expect(section?.kind === "section" && section.blocks.map((block) => block.id)).toEqual(["metric-1", "table-1", "chart-1"]);
        expect(draft).toEqual(before);
    });

    it("refuses a move into its own subtree with cycle", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const failure = moveBlock(draft, { targetId: "outer", destination: { parentId: "inner" } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("cycle");
        expect(draft).toEqual(before);
    });

    it("refuses a self-anchor move with unknown-target", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const failure = moveBlock(draft, { targetId: "metric-1", destination: { place: { after: "metric-1" } } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });

    it("refuses an unknown target with unknown-target", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const failure = moveBlock(draft, { targetId: "ghost", destination: { parentId: "sec-2" } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("unknown-target");
        expect(draft).toEqual(before);
    });

    it("refuses a move into an atom parent with not-a-section", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const failure = moveBlock(draft, { targetId: "text-1", destination: { parentId: "metric-1" } }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("not-a-section");
        expect(draft).toEqual(before);
    });

    it("refuses a move of an atom to the root with atom-at-root", () => {
        const draft = nestedDraft();
        const before = structuredClone(draft);
        const failure = moveBlock(draft, { targetId: "metric-1", destination: {} }, snapshot)._unsafeUnwrapErr();

        expect(failure.reason).toBe("atom-at-root");
        expect(draft).toEqual(before);
    });
});
