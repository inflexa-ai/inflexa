/**
 * The shape of the primary matrix is the profiler's own measurement. These assert what the
 * submit schema accepts and refuses, that the snapshot copies it, and that a deterministic
 * absorb keeps it only while the inputs it measured are unchanged.
 */

import { describe, expect, it } from "bun:test";

import type { DataProfileResult, DataProfileShape } from "../../contracts/data-profile.js";
import { computeInputSignature } from "../../execution/input-signature.js";
import type { StagedInput } from "../../execution/staged-input.js";
import { detectSets } from "../../input-scan/detect-sets.js";
import { buildSetMenu } from "../../input-scan/menu.js";
import type { ScannedFile } from "../../input-scan/types.js";
import { ProfileSubmissionSchema, type ProfileSubmission } from "../../schemas/data-profile-schemas.js";
import { buildAbsorbedResult, buildDataProfileResult } from "../data-profile.js";
import { resolveProfileSubmission } from "../data-profile-resolve.js";

const SHAPE: DataProfileShape = { rows: 61533, rowUnit: "genes", columns: 28, columnUnit: "samples" };

const files: ScannedFile[] = [
    { path: "data/inputs/counts.tsv", size: 100, extensions: ["tsv"], format: "tsv" },
    { path: "data/inputs/README.md", size: 100, extensions: ["md"], format: "markdown" },
];
const detected = detectSets(files);
const menu = buildSetMenu(detected);

function staged(fileId: string, size: number): StagedInput {
    return {
        fileId,
        mountName: fileId,
        key: `${fileId}.tsv`,
        fileName: `${fileId}.tsv`,
        hash: `hash-${fileId}`,
        size,
        mtimeMs: 1_780_000_000_000,
        relativePath: `inputs/${fileId}.tsv`,
    };
}

function submission(over: Record<string, unknown> = {}): ProfileSubmission {
    const parsed = ProfileSubmissionSchema.parse({
        operations: [
            { op: "group", paths: ["data/inputs/counts.tsv"], group: annotation("counts", "data", "expression-matrix") },
            { op: "group", paths: ["data/inputs/README.md"], group: annotation("readme", "documentation", "document") },
        ],
        analysisSummary: "A synthetic tree.",
        domain: "transcriptomics",
        organism: null,
        ...over,
    });
    return parsed;
}

function annotation(name: string, role: string, category: string) {
    return { name, memberRepresents: `one ${name} member`, description: `What ${name} holds.`, role, category };
}

const resolution = resolveProfileSubmission(submission(), detected, menu);

describe("the shape on a submission", () => {
    it("is optional", () => {
        expect(ProfileSubmissionSchema.safeParse({ ...submission(), shape: undefined }).success).toBe(true);
    });

    it("is accepted with positive integer dimensions and named units", () => {
        expect(submission({ shape: SHAPE }).shape).toEqual(SHAPE);
    });

    it.each([
        ["rows of zero", { ...SHAPE, rows: 0 }, "rows"],
        ["a fractional count of columns", { ...SHAPE, columns: 2.5 }, "columns"],
        ["an empty column unit", { ...SHAPE, columnUnit: "" }, "columnUnit"],
        ["a blank row unit", { ...SHAPE, rowUnit: "   " }, "rowUnit"],
    ])("is refused with %s, and the error names the field", (_label, shape, field) => {
        const parsed = ProfileSubmissionSchema.safeParse({ ...submission(), shape });
        expect(parsed.success).toBe(false);
        if (parsed.success) return;
        expect(parsed.error.issues.some((issue) => issue.path[0] === "shape" && issue.path[1] === field)).toBe(true);
    });
});

describe("the shape on the snapshot", () => {
    it("is copied from the submission", () => {
        const record = buildDataProfileResult(submission({ shape: SHAPE }), resolution, [staged("a", 10)], "2020-01-01T00:00:00.000Z");
        expect(record.shape).toEqual(SHAPE);
    });

    it("has no key in the stored JSON when the submission has none", () => {
        const record = buildDataProfileResult(submission(), resolution, [staged("a", 10)], "2020-01-01T00:00:00.000Z");
        expect(JSON.stringify(record)).not.toContain('"shape"');
    });
});

describe("the shape across an absorb", () => {
    const original = [staged("a", 10), staged("b", 20)];
    const prior: DataProfileResult = {
        ...buildDataProfileResult(submission({ shape: SHAPE }), resolution, original, "2020-01-01T00:00:00.000Z"),
        inputSignature: computeInputSignature(original),
    };

    it("is kept when the input signature did not change", () => {
        const absorbed = buildAbsorbedResult(prior, resolution, [...original].reverse(), "2020-02-01T00:00:00.000Z");
        expect(absorbed.shape).toEqual(SHAPE);
    });

    it("is dropped, with no key, when an input is added", () => {
        const absorbed = buildAbsorbedResult(prior, resolution, [...original, staged("c", 30)], "2020-02-01T00:00:00.000Z");
        expect("shape" in absorbed).toBe(false);
    });

    it("is dropped when an input changed in place", () => {
        const absorbed = buildAbsorbedResult(prior, resolution, [staged("a", 11), staged("b", 20)], "2020-02-01T00:00:00.000Z");
        expect("shape" in absorbed).toBe(false);
    });

    it("is dropped when the prior snapshot recorded no signature", () => {
        const { inputSignature: _dropped, ...unsigned } = prior;
        const absorbed = buildAbsorbedResult(unsigned, resolution, original, "2020-02-01T00:00:00.000Z");
        expect("shape" in absorbed).toBe(false);
    });
});
