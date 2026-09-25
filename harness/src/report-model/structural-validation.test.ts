import { describe, expect, it } from "bun:test";

import type {
    ArtifactFileReference,
    ArtifactTableReference,
    ArtifactValueReference,
    CitationReference,
    DerivationReference,
    Reference,
    UnresolvedReference,
} from "../contracts/report-reference.js";
import type { ChartBlock } from "../contracts/report-blocks.js";
import { walkBlocks } from "./block-walk.js";
import type { ReportSnapshot } from "./reference-resolver.js";
import { validateReferenceStructure } from "./structural-validation.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const SECOND_OUTPUT_PATH = "runs/run-1/step-b/output/counts.csv";
const FIGURE_PATH = "runs/run-1/step-a/figures/volcano.png";
const SCRIPT_PATH = "runs/run-1/step-a/scripts/de.R";
const LOG_PATH = "runs/run-1/step-a/logs/step.log";
const NOTEBOOK_PATH = "runs/run-1/step-a/notebooks/report.ipynb";
const ABSENT_TYPE_PATH = "runs/run-1/step-a/output/absent-type.csv";
const UNDEFINED_TYPE_PATH = "runs/run-1/step-a/output/undefined-type.csv";
const NULL_TYPE_PATH = "runs/run-1/step-a/output/null-type.csv";
// The output of a later run. The snapshot froze before that run, thus it holds no entry for this path.
const ABSENT_PATH = "runs/run-2/step-a/output/later.csv";

const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;
const SECOND_OUTPUT_HASH = `sha256:${"b".repeat(64)}`;
const FIGURE_HASH = `sha256:${"c".repeat(64)}`;
const SCRIPT_HASH = `sha256:${"d".repeat(64)}`;
const LOG_HASH = `sha256:${"e".repeat(64)}`;
const NOTEBOOK_HASH = `sha256:${"f".repeat(64)}`;
const ABSENT_TYPE_HASH = `sha256:${"0".repeat(64)}`;
const UNDEFINED_TYPE_HASH = `sha256:${"1".repeat(64)}`;
const NULL_TYPE_HASH = `sha256:${"2".repeat(64)}`;
const ABSENT_HASH = `sha256:${"3".repeat(64)}`;
const WRONG_HASH = `sha256:${"9".repeat(64)}`;

const snapshot: ReportSnapshot = {
    artifacts: {
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
        [SECOND_OUTPUT_PATH]: { hash: SECOND_OUTPUT_HASH, fileType: "output" },
        [FIGURE_PATH]: { hash: FIGURE_HASH, fileType: "figure" },
        [SCRIPT_PATH]: { hash: SCRIPT_HASH, fileType: "script" },
        [LOG_PATH]: { hash: LOG_HASH, fileType: "log" },
        [NOTEBOOK_PATH]: { hash: NOTEBOOK_HASH, fileType: "notebook" },
        // The three shapes of an entry that states no file type: the key is absent, the key holds
        // `undefined`, and the key holds `null`.
        [ABSENT_TYPE_PATH]: { hash: ABSENT_TYPE_HASH },
        [UNDEFINED_TYPE_PATH]: { hash: UNDEFINED_TYPE_HASH, fileType: undefined },
        [NULL_TYPE_PATH]: { hash: NULL_TYPE_HASH, fileType: null },
    },
};

function valueReference(path: string, hash: string): ArtifactValueReference {
    return {
        kind: "artifact-value",
        path,
        hash,
        locator: { column: "padj", rowFilter: { column: "gene", op: "eq", value: "TP53" } },
    };
}

function tableReference(path: string, hash: string): ArtifactTableReference {
    return { kind: "artifact-table", path, hash };
}

function fileReference(path: string, hash: string): ArtifactFileReference {
    return { kind: "artifact-file", path, hash };
}

function derivationReference(first: ArtifactValueReference, second: ArtifactValueReference): DerivationReference {
    return { kind: "derivation", op: "ratio", inputs: [first, second] };
}

/**
 * Validate one reference, and give its failure or `undefined` for a pass. A pass then asserts against
 * `undefined`, thus a broken rule reports its reason and not only `false`.
 */
function failureFor(reference: Reference, pinnedEvidence: ReportSnapshot = snapshot): UnresolvedReference | undefined {
    return validateReferenceStructure(reference, pinnedEvidence).match(
        () => undefined,
        (failure) => failure,
    );
}

describe("validateReferenceStructure", () => {
    describe("the artifact pin", () => {
        it("fails a path that the snapshot does not hold", () => {
            const failure = failureFor(valueReference(ABSENT_PATH, ABSENT_HASH));
            expect(failure?.reason).toBe("artifact-missing");
            expect(failure?.detail).toContain(ABSENT_PATH);
        });

        it("fails a hash that differs from the entry", () => {
            const failure = failureFor(valueReference(OUTPUT_PATH, WRONG_HASH));
            expect(failure?.reason).toBe("hash-mismatch");
        });

        it("fails an artifact-table against a path that the snapshot does not hold", () => {
            const failure = failureFor(tableReference(ABSENT_PATH, ABSENT_HASH));
            expect(failure?.reason).toBe("artifact-missing");
            expect(failure?.detail).toContain(ABSENT_PATH);
        });

        it("fails an artifact-file whose hash differs from the entry", () => {
            expect(failureFor(fileReference(OUTPUT_PATH, WRONG_HASH))?.reason).toBe("hash-mismatch");
        });

        it("fails an artifact-value whose path is constructor with artifact-missing and not hash-mismatch", () => {
            // An agent authors the path, thus it is untrusted text. An inherited member of a plain object,
            // for example `constructor`, must not read as an entry.
            expect(failureFor(valueReference("constructor", WRONG_HASH))?.reason).toBe("artifact-missing");
        });

        it("passes a pin that names the entry and its hash", () => {
            expect(failureFor(valueReference(OUTPUT_PATH, OUTPUT_HASH))).toBeUndefined();
        });
    });

    describe("the file type", () => {
        const typesWithNoCell = [
            { fileType: "figure", path: FIGURE_PATH, hash: FIGURE_HASH },
            { fileType: "script", path: SCRIPT_PATH, hash: SCRIPT_HASH },
            { fileType: "log", path: LOG_PATH, hash: LOG_HASH },
            { fileType: "notebook", path: NOTEBOOK_PATH, hash: NOTEBOOK_HASH },
        ];

        for (const entry of typesWithNoCell) {
            it(`refuses an artifact-value against a ${entry.fileType}`, () => {
                expect(failureFor(valueReference(entry.path, entry.hash))?.reason).toBe("unreadable-artifact");
            });
        }

        it("refuses an artifact-table against a log", () => {
            expect(failureFor(tableReference(LOG_PATH, LOG_HASH))?.reason).toBe("unreadable-artifact");
        });

        it("passes an artifact-value against an output, which covers a table and an image alike", () => {
            expect(failureFor(valueReference(OUTPUT_PATH, OUTPUT_HASH))).toBeUndefined();
        });

        it("passes an artifact-value against an entry whose file type key is absent", () => {
            expect(failureFor(valueReference(ABSENT_TYPE_PATH, ABSENT_TYPE_HASH))).toBeUndefined();
        });

        it("passes an artifact-value against an entry whose file type is undefined", () => {
            expect(failureFor(valueReference(UNDEFINED_TYPE_PATH, UNDEFINED_TYPE_HASH))).toBeUndefined();
        });

        it("passes an artifact-value against an entry whose file type is null", () => {
            expect(failureFor(valueReference(NULL_TYPE_PATH, NULL_TYPE_HASH))).toBeUndefined();
        });

        it("passes an artifact-file against a figure, because a file reference pins the bytes of a whole file", () => {
            expect(failureFor(fileReference(FIGURE_PATH, FIGURE_HASH))).toBeUndefined();
        });
    });

    describe("a reference with no artifact pin", () => {
        it("passes a citation", () => {
            const citation: CitationReference = { kind: "citation", idKind: "pmid", id: "12345", raw: "A study of TP53, 2024" };
            expect(failureFor(citation)).toBeUndefined();
        });

        it("passes a derivation whose two inputs both pass", () => {
            const derivation = derivationReference(valueReference(OUTPUT_PATH, OUTPUT_HASH), valueReference(SECOND_OUTPUT_PATH, SECOND_OUTPUT_HASH));
            expect(failureFor(derivation)).toBeUndefined();
        });

        it("fails a derivation whose first input is absent, with the reason of that input", () => {
            const derivation = derivationReference(valueReference(ABSENT_PATH, ABSENT_HASH), valueReference(SECOND_OUTPUT_PATH, SECOND_OUTPUT_HASH));
            const failure = failureFor(derivation);
            expect(failure?.reason).toBe("artifact-missing");
            expect(failure?.detail).toContain(ABSENT_PATH);
        });

        it("fails a derivation whose second input is absent, with the reason of that input", () => {
            const derivation = derivationReference(valueReference(OUTPUT_PATH, OUTPUT_HASH), valueReference(ABSENT_PATH, ABSENT_HASH));
            const failure = failureFor(derivation);
            expect(failure?.reason).toBe("artifact-missing");
            expect(failure?.detail).toContain(ABSENT_PATH);
        });
    });

    describe("the assert", () => {
        it("passes a reference that carries an assert, because the tier matches no assertion", () => {
            // The snapshot holds no cell, thus nothing here can satisfy the authored belief. The pass
            // proves that the tier answers on the pin alone.
            const reference: ArtifactValueReference = { ...valueReference(OUTPUT_PATH, OUTPUT_HASH), assert: { value: 0.0001 } };
            expect(failureFor(reference)).toBeUndefined();
        });
    });

    describe("the columns of a chart grammar", () => {
        // A fixture snapshot carries the rows of its artifacts, thus the tier can answer a column match
        // from the snapshot alone.
        const ROWS_PATH = "runs/run-1/step-c/output/de-rows.csv";
        const ROWS_HASH = `sha256:${"7".repeat(64)}`;
        const rowSnapshot: ReportSnapshot = {
            artifacts: {
                ...snapshot.artifacts,
                [ROWS_PATH]: { hash: ROWS_HASH, fileType: "output", rows: [{ gene: "TP53", log2FoldChange: 6, padj: 0.001 }] },
            },
        };

        /** Validate one chart binding against the named grammar columns. */
        function columnFailure(columns: string[], reference = tableReference(ROWS_PATH, ROWS_HASH)): UnresolvedReference | undefined {
            return validateReferenceStructure(reference, rowSnapshot, columns).match(
                () => undefined,
                (failure) => failure,
            );
        }

        it("passes a composition whose every column is a column of the bound table", () => {
            expect(columnFailure(["gene", "log2FoldChange", "padj"])).toBeUndefined();
        });

        it("refuses a column that the bound table does not hold", () => {
            const failure = columnFailure(["log2FoldChange", "invented"]);
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("invented");
        });

        it("refuses a column that the declared column subset leaves out", () => {
            const projection = { ...tableReference(ROWS_PATH, ROWS_HASH), columns: ["gene"] };
            const failure = columnFailure(["gene", "padj"], projection);
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("padj");
        });

        it("passes each column against a snapshot that pins identity and holds no row", () => {
            // A production snapshot carries no row. It contradicts no name, thus the value tier settles the
            // match over the artifact that it reads.
            expect(columnFailure(["invented"], tableReference(OUTPUT_PATH, OUTPUT_HASH))).toBeUndefined();
        });

        it("refuses a bad pin before it looks at one column", () => {
            const failure = columnFailure(["invented"], tableReference(ROWS_PATH, WRONG_HASH));
            expect(failure?.reason).toBe("hash-mismatch");
        });

        it("passes a row bound over a column of the bound table", () => {
            const bounded = { ...tableReference(ROWS_PATH, ROWS_HASH), rowBound: { column: "padj", count: 20, order: "asc" as const } };
            expect(failureFor(bounded, rowSnapshot)).toBeUndefined();
        });

        it("refuses a row bound over a column that the table does not hold", () => {
            const bounded = { ...tableReference(ROWS_PATH, ROWS_HASH), rowBound: { column: "invented", count: 20 } };

            // The bound decides which rows the table holds, thus an unknown bound column refuses before the
            // block lands, exactly as an unknown grammar column does.
            const failure = failureFor(bounded, rowSnapshot);
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("invented");
        });

        it("refuses a row bound over an inherited member of a plain object", () => {
            const bounded = { ...tableReference(ROWS_PATH, ROWS_HASH), rowBound: { column: "constructor", count: 20 } };

            // A stored snapshot parses into a plain object. A membership test that read the prototype would
            // admit this name as a column, and the value tier would then rank a function.
            const failure = failureFor(bounded, rowSnapshot);
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("constructor");
        });

        /** The grammar columns that the walk collects for one chart over the rows artifact. */
        function walkedColumns(encoding: ChartBlock["encoding"], composition?: ChartBlock["composition"]): string[] {
            const block: ChartBlock =
                composition !== undefined
                    ? { kind: "chart", id: "c1", binding: tableReference(ROWS_PATH, ROWS_HASH), composition }
                    : { kind: "chart", id: "c1", binding: tableReference(ROWS_PATH, ROWS_HASH), chartType: "scatter", encoding };
            return walkBlocks([block]).references[0]?.encodingColumns ?? [];
        }

        it("refuses an invented column in a color channel, a composition facet, and an order column", () => {
            // Each new member of the grammar names a column. The walk collects it, thus the structural tier
            // refuses an invented one before the block lands, exactly as it refuses an invented x.
            const color = columnFailure(walkedColumns({ x: "log2FoldChange", y: "padj", color: "invented_color" }));
            expect(color?.reason).toBe("locator-out-of-range");
            expect(color?.detail).toContain("invented_color");

            const facet = columnFailure(
                walkedColumns(undefined, { series: [{ form: "scatter", encoding: { x: "log2FoldChange", y: "padj" } }], facet: "invented_facet" }),
            );
            expect(facet?.reason).toBe("locator-out-of-range");
            expect(facet?.detail).toContain("invented_facet");

            const order = columnFailure(walkedColumns({ x: { column: "gene", orderBy: "invented_rank" }, y: "padj" }));
            expect(order?.reason).toBe("locator-out-of-range");
            expect(order?.detail).toContain("invented_rank");
        });

        it("refuses an invented column in a channel of the canonical figures and in the track columns", () => {
            const shape = columnFailure(walkedColumns({ x: "log2FoldChange", y: "padj", shape: "invented_shape" }));
            expect(shape?.reason).toBe("locator-out-of-range");
            expect(shape?.detail).toContain("invented_shape");

            const tracks = columnFailure(walkedColumns({ x: "gene", y: "padj", tracks: ["log2FoldChange", "invented_track"] }));
            expect(tracks?.reason).toBe("locator-out-of-range");
            expect(tracks?.detail).toContain("invented_track");
        });

        it("refuses a track column that the track table does not hold, against the rows of the track table", () => {
            const TRACK_PATH = "runs/run-1/step-d/output/domains.csv";
            const TRACK_HASH = `sha256:${"8".repeat(64)}`;
            const withTrack: ReportSnapshot = {
                artifacts: { ...rowSnapshot.artifacts, [TRACK_PATH]: { hash: TRACK_HASH, fileType: "output", rows: [{ start: 1, end: 90, domain: "PWWP" }] } },
            };
            const block: ChartBlock = {
                kind: "chart",
                id: "c1",
                binding: tableReference(ROWS_PATH, ROWS_HASH),
                chartType: "lollipop",
                encoding: { x: "log2FoldChange", y: "padj" },
                track: { binding: tableReference(TRACK_PATH, TRACK_HASH), start: "start", end: "end", label: "domain", length: "invented_length" },
            };
            const track = walkBlocks([block]).references.find((entry) => entry.slot === "track");
            const failure = validateReferenceStructure(track?.reference ?? tableReference(TRACK_PATH, TRACK_HASH), withTrack, track?.encodingColumns).match(
                () => undefined,
                (refusal) => refusal,
            );
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("invented_length");
            // The binding of the chart reads its own table, thus the track columns never reach its match.
            const bound = walkBlocks([block]).references[0];
            expect(validateReferenceStructure(bound.reference, withTrack, bound.encodingColumns).isOk()).toBe(true);
        });

        it("refuses a tree column that the tree table does not hold, against the rows of the tree table", () => {
            const TREE_PATH = "runs/run-1/step-d/output/gene_tree.csv";
            const TREE_HASH = `sha256:${"9".repeat(64)}`;
            const withTree: ReportSnapshot = {
                artifacts: {
                    ...rowSnapshot.artifacts,
                    [TREE_PATH]: { hash: TREE_HASH, fileType: "output", rows: [{ parent: "n1", child: "TP53", height: 0.4 }] },
                },
            };
            const block: ChartBlock = {
                kind: "chart",
                id: "c1",
                binding: tableReference(ROWS_PATH, ROWS_HASH),
                chartType: "heatmap",
                encoding: { x: "log2FoldChange", y: "padj" },
                trees: { y: { binding: tableReference(TREE_PATH, TREE_HASH), parent: "parent", child: "child", height: "invented_height" } },
            };
            const tree = walkBlocks([block]).references.find((entry) => entry.slot === "tree:y");
            const failure = validateReferenceStructure(tree?.reference ?? tableReference(TREE_PATH, TREE_HASH), withTree, tree?.encodingColumns).match(
                () => undefined,
                (refusal) => refusal,
            );
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("invented_height");
            // The binding of the chart reads its own table, thus the tree columns never reach its match.
            const bound = walkBlocks([block]).references[0];
            expect(validateReferenceStructure(bound.reference, withTree, bound.encodingColumns).isOk()).toBe(true);
        });

        it("refuses a chart column that names an inherited member of a plain object", () => {
            const failure = columnFailure(["constructor"]);
            expect(failure?.reason).toBe("locator-out-of-range");
            expect(failure?.detail).toContain("constructor");
        });

        it("passes a row bound against a snapshot that pins identity and holds no row", () => {
            const bounded = { ...tableReference(OUTPUT_PATH, OUTPUT_HASH), rowBound: { column: "invented", count: 20 } };
            expect(failureFor(bounded, rowSnapshot)).toBeUndefined();
        });
    });

    describe("the read of a file", () => {
        it("passes a sound reference whose path holds no file on disk", () => {
            // The path is under a run directory that nothing ever made, thus a read of it must fail. The
            // reference still passes, thus the answer came from the snapshot alone and nothing opened a
            // file.
            const ghostPath = "runs/run-does-not-exist/step-z/output/ghost.csv";
            const ghostHash = `sha256:${"8".repeat(64)}`;
            const diskFreeSnapshot: ReportSnapshot = { artifacts: { [ghostPath]: { hash: ghostHash, fileType: "output" } } };
            expect(failureFor(valueReference(ghostPath, ghostHash), diskFreeSnapshot)).toBeUndefined();
        });
    });
});
