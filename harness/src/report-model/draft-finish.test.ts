import { describe, expect, it } from "bun:test";

import type { ArtifactValueReference } from "../contracts/report-reference.js";
import type { DraftDocument } from "./draft.js";
import { finishDraft } from "./draft-finish.js";
import type { ReportSnapshot } from "./reference-resolver.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;
const ABSENT_PATH = "runs/run-2/step-a/output/later.csv";
const ABSENT_HASH = `sha256:${"3".repeat(64)}`;

const snapshot: ReportSnapshot = {
    artifacts: {
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
    },
};

function valueReference(path: string = OUTPUT_PATH, hash: string = OUTPUT_HASH): ArtifactValueReference {
    return {
        kind: "artifact-value",
        path,
        hash,
        locator: { column: "padj", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
    };
}

describe("finishDraft", () => {
    it("reports an empty section as a schema gap, and gives no document", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [] }],
        };
        const result = finishDraft(draft, snapshot);
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.gaps.some((gap) => gap.kind === "schema")).toBe(true);
        }
        expect("document" in result).toBe(false);
    });

    it("reports an empty draft as a schema gap", () => {
        const draft: DraftDocument = { title: "Report", sections: [] };
        const result = finishDraft(draft, snapshot);
        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.gaps.some((gap) => gap.kind === "schema")).toBe(true);
        }
    });

    it("reports a duplicate id as a duplicate-id gap", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [
                        { kind: "text", id: "dup", content: { prose: "first" } },
                        { kind: "text", id: "dup", content: { prose: "second" } },
                    ],
                },
            ],
        };
        const result = finishDraft(draft, snapshot);
        expect(result.valid).toBe(false);
        if (!result.valid) {
            const gap = result.gaps.find((entry) => entry.kind === "duplicate-id");
            expect(gap).toBeDefined();
            if (gap?.kind === "duplicate-id") {
                expect(gap.id).toBe("dup");
            }
        }
    });

    it("reports a reference outside the snapshot as an unresolved-reference gap with the block id", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "metric", id: "m1", label: "Coverage", value: valueReference(ABSENT_PATH, ABSENT_HASH) }],
                },
            ],
        };
        const result = finishDraft(draft, snapshot);
        expect(result.valid).toBe(false);
        if (!result.valid) {
            const gap = result.gaps.find((entry) => entry.kind === "unresolved-reference");
            expect(gap).toBeDefined();
            if (gap?.kind === "unresolved-reference") {
                expect(gap.blockId).toBe("m1");
                expect(gap.failure.reason).toBe("artifact-missing");
            }
        }
    });

    it("gives the document value for a complete valid draft, and does not change the draft", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [
                        { kind: "text", id: "t1", content: { prose: "Body." } },
                        { kind: "metric", id: "m1", label: "Coverage", value: valueReference() },
                    ],
                },
            ],
        };
        const original = structuredClone(draft);
        const result = finishDraft(draft, snapshot);
        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.document.title).toBe("Report");
            expect(result.document.sections.length).toBe(1);
        }
        expect(draft).toEqual(original);
    });
});
