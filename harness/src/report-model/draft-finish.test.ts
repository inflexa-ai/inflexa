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

/** The content hash that each derived table of these tests carries. */
const DERIVED_HASH = `sha256:${"b".repeat(64)}`;

/** A snapshot that holds the pinned output and one derived table, as the served membership gives it. */
function derivedSnapshot(derived: string): ReportSnapshot {
    return {
        artifacts: {
            [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
            [derived]: { hash: DERIVED_HASH },
        },
    };
}

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

describe("the finish warnings", () => {
    it("warns about a free numeral in prose, and the draft still finishes", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "text", id: "t1", content: { prose: "Expression rose 3.4 fold in TP53." } }],
                },
            ],
        };
        const result = finishDraft(draft, snapshot);

        // The numeral has no metric block behind it, and nothing else in the finish catches that.
        expect(result.warnings).toEqual([{ blockId: "t1", kind: "free-numeral", detail: "3.4" }]);
        expect(result.valid).toBe(true);
    });

    it("keeps the digits of a gene symbol out of the warnings", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "TP53 and CD8 and IL6." } }] }],
        };
        expect(finishDraft(draft, snapshot).warnings).toEqual([]);
    });

    it("carries the warnings beside the gaps of a draft that does not finish", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                { kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "A rise of 12 percent." } }] },
                { kind: "section", id: "s2", title: "Empty", blocks: [] },
            ],
        };
        const result = finishDraft(draft, snapshot);

        expect(result.valid).toBe(false);
        expect(result.warnings).toEqual([{ blockId: "t1", kind: "free-numeral", detail: "12" }]);
    });

    it("warns about a derivation that no binding names, and the draft still finishes", () => {
        const used = "report-sessions/t1/derived/used.csv";
        const unused = "report-sessions/t1/derived/unused.csv";
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "table", id: "tb1", binding: { kind: "artifact-table", path: used, hash: DERIVED_HASH } }],
                },
            ],
        };
        const result = finishDraft(draft, derivedSnapshot(used), [{ outputPath: used }, { outputPath: unused }]);

        // The used derivation warns nothing, and the unused one names its output path.
        expect(result.warnings).toEqual([{ kind: "unused-derivation", detail: unused }]);
        // A warning decides no outcome, thus the draft finishes.
        expect(result.valid).toBe(true);
    });

    it("warns nothing when every derivation output is named by a binding", () => {
        const used = "report-sessions/t1/derived/used.csv";
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [{ kind: "table", id: "tb1", binding: { kind: "artifact-table", path: used, hash: DERIVED_HASH } }],
                },
            ],
        };
        expect(finishDraft(draft, derivedSnapshot(used), [{ outputPath: used }]).warnings).toEqual([]);
    });

    it("counts a derivation that a chart binds", () => {
        const used = "report-sessions/t1/derived/used.csv";
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [
                        {
                            kind: "chart",
                            id: "ch1",
                            binding: { kind: "artifact-table", path: used, hash: DERIVED_HASH },
                            chartType: "bar",
                            encoding: { x: "gene", y: "padj" },
                        },
                    ],
                },
            ],
        };

        // A chart plots the whole table, thus its binding names the derived path and the derivation is used.
        expect(finishDraft(draft, derivedSnapshot(used), [{ outputPath: used }]).warnings).toEqual([]);
    });

    it("counts a derivation that a claim binds through a value reference", () => {
        const used = "report-sessions/t1/derived/used.csv";
        const draft: DraftDocument = {
            title: "Report",
            sections: [
                {
                    kind: "section",
                    id: "s1",
                    title: "Intro",
                    blocks: [
                        {
                            kind: "claim",
                            id: "c1",
                            content: { prose: "A claim." },
                            bindings: [{ kind: "artifact-value", path: used, hash: DERIVED_HASH, locator: { column: "padj", row: 0 } }],
                        },
                    ],
                },
            ],
        };

        // A binding of any kind names the path, thus a cell of the derived table uses the derivation.
        expect(finishDraft(draft, derivedSnapshot(used), [{ outputPath: used }]).warnings).toEqual([]);
    });

    it("warns nothing for a session that derived nothing", () => {
        const draft: DraftDocument = {
            title: "Report",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "Body." } }] }],
        };
        expect(finishDraft(draft, snapshot).warnings).toEqual([]);
        expect(finishDraft(draft, snapshot, []).warnings).toEqual([]);
    });

    it("reports an empty title as a schema gap", () => {
        const draft: DraftDocument = {
            title: "",
            sections: [{ kind: "section", id: "s1", title: "Intro", blocks: [{ kind: "text", id: "t1", content: { prose: "Body." } }] }],
        };
        const result = finishDraft(draft, snapshot);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.gaps.some((gap) => gap.kind === "schema" && gap.path === "title")).toBe(true);
        }
    });
});
