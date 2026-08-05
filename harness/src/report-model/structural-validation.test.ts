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
