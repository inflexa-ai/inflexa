/**
 * The tests of the hash stamp.
 *
 * The stamp runs before the grammar parse, thus each test drives it with a plain payload and reads the
 * value that it gives back. The tests cover the fill, the unknown path, the explicit hash, a derivation
 * input, a value that is not a reference, the faithful copy, and the intact input.
 */

import { describe, expect, it } from "bun:test";

import type { ReportSnapshot } from "./reference-resolver.js";
import { stampReferenceHashes } from "./reference-stamp.js";

const OUTPUT_PATH = "runs/run-1/step-a/output/de.csv";
const OUTPUT_HASH = `sha256:${"a".repeat(64)}`;
const SECOND_PATH = "runs/run-1/step-a/output/counts.csv";
const SECOND_HASH = `sha256:${"b".repeat(64)}`;
// The output of a later run. The snapshot froze before that run, thus it holds no entry for this path.
const ABSENT_PATH = "runs/run-2/step-a/output/later.csv";

const snapshot: ReportSnapshot = {
    artifacts: {
        [OUTPUT_PATH]: { hash: OUTPUT_HASH, fileType: "output" },
        [SECOND_PATH]: { hash: SECOND_HASH, fileType: "output" },
    },
};

/** Read one field of a stamped payload. The stamp gives an unknown value, thus each test narrows it here. */
function field(value: unknown, ...keys: Array<string | number>): unknown {
    let current: unknown = value;
    for (const key of keys) {
        if (current === null || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string | number, unknown>)[key];
    }
    return current;
}

describe("the fill", () => {
    it("stamps the snapshot hash on a path-only reference", () => {
        const payload = {
            kind: "table",
            id: "table-1",
            binding: { kind: "artifact-table", path: OUTPUT_PATH },
        };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(field(stamped, "binding", "hash")).toBe(OUTPUT_HASH);
        expect(field(stamped, "binding", "path")).toBe(OUTPUT_PATH);
    });

    it("stamps each reference of a nested section payload", () => {
        const payload = {
            kind: "section",
            id: "sec-1",
            title: "First",
            blocks: [
                { kind: "table", id: "table-1", binding: { kind: "artifact-table", path: OUTPUT_PATH } },
                { kind: "figure", id: "fig-1", binding: { kind: "artifact-file", path: SECOND_PATH }, caption: "A plot" },
            ],
        };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(field(stamped, "blocks", 0, "binding", "hash")).toBe(OUTPUT_HASH);
        expect(field(stamped, "blocks", 1, "binding", "hash")).toBe(SECOND_HASH);
    });

    it("stamps each input of a derivation", () => {
        const payload = {
            kind: "metric",
            id: "metric-1",
            label: "ratio",
            value: {
                kind: "derivation",
                op: "ratio",
                inputs: [
                    { kind: "artifact-value", path: OUTPUT_PATH, locator: { column: "padj", row: 0 } },
                    { kind: "artifact-value", path: SECOND_PATH, locator: { column: "padj", row: 1 } },
                ],
            },
        };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(field(stamped, "value", "inputs", 0, "hash")).toBe(OUTPUT_HASH);
        expect(field(stamped, "value", "inputs", 1, "hash")).toBe(SECOND_HASH);
        // The derivation itself pins no artifact, thus it takes no hash.
        expect(field(stamped, "value", "hash")).toBeUndefined();
    });
});

describe("the unknown path", () => {
    it("refuses, and the detail names the path", () => {
        const payload = {
            kind: "table",
            id: "table-1",
            binding: { kind: "artifact-table", path: ABSENT_PATH },
        };

        const refusal = stampReferenceHashes(payload, snapshot)._unsafeUnwrapErr();

        expect(refusal.reason).toBe("unresolved-reference");
        expect(refusal.detail).toContain(ABSENT_PATH);
        if (refusal.reason === "unresolved-reference") {
            expect(refusal.unresolved).toHaveLength(1);
            expect(refusal.unresolved[0].reason).toBe("artifact-missing");
            expect(refusal.unresolved[0].detail).toContain(ABSENT_PATH);
        }
    });

    it("names every unknown path of one payload", () => {
        const other = "runs/run-2/step-b/output/other.csv";
        const payload = {
            kind: "section",
            id: "sec-1",
            title: "First",
            blocks: [
                { kind: "table", id: "table-1", binding: { kind: "artifact-table", path: ABSENT_PATH } },
                { kind: "figure", id: "fig-1", binding: { kind: "artifact-file", path: other }, caption: "A plot" },
            ],
        };

        const refusal = stampReferenceHashes(payload, snapshot)._unsafeUnwrapErr();

        expect(refusal.detail).toContain(ABSENT_PATH);
        expect(refusal.detail).toContain(other);
        if (refusal.reason === "unresolved-reference") {
            expect(refusal.unresolved).toHaveLength(2);
        }
    });
});

describe("the explicit hash", () => {
    it("keeps a hash that the author gave, even when it differs from the snapshot", () => {
        const stale = `sha256:${"c".repeat(64)}`;
        const payload = {
            kind: "table",
            id: "table-1",
            binding: { kind: "artifact-table", path: OUTPUT_PATH, hash: stale },
        };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        // The stamp fills an absent hash only, thus the structural tier still reads the stale hash and
        // refuses it as a mismatch.
        expect(field(stamped, "binding", "hash")).toBe(stale);
    });

    it("keeps an explicit hash whose path the snapshot does not hold, and it refuses nothing", () => {
        const payload = {
            kind: "table",
            id: "table-1",
            binding: { kind: "artifact-table", path: ABSENT_PATH, hash: OUTPUT_HASH },
        };

        const stamped = stampReferenceHashes(payload, snapshot);

        expect(stamped.isOk()).toBe(true);
    });
});

describe("the value that is not a reference", () => {
    it("passes a block with no reference through untouched", () => {
        const payload = { kind: "text", id: "text-1", content: { prose: "Intro." } };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(stamped).toBe(payload);
    });

    it("passes an object that names a path under a kind that pins nothing through untouched", () => {
        const payload = { kind: "citation", id: "cite-1", binding: { kind: "citation", idKind: "pmid", id: "12345", raw: "A paper", path: OUTPUT_PATH } };

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(field(stamped, "binding", "hash")).toBeUndefined();
        expect(stamped).toBe(payload);
    });

    it("passes a scalar, an array of scalars, and a null through untouched", () => {
        expect(stampReferenceHashes("plain text", snapshot)._unsafeUnwrap()).toBe("plain text");
        expect(stampReferenceHashes(7, snapshot)._unsafeUnwrap()).toBe(7);
        expect(stampReferenceHashes(null, snapshot)._unsafeUnwrap()).toBeNull();
        const list = [1, "two", null];
        expect(stampReferenceHashes(list, snapshot)._unsafeUnwrap()).toBe(list);
    });
});

describe("the faithful copy", () => {
    it("copies an own key that names the prototype, and it keeps the copy a plain object", () => {
        // `JSON.parse` makes an own `__proto__` key, and a stored payload arrives through it. An object
        // literal cannot express the same key, because the literal sets the prototype.
        const payload: unknown = JSON.parse(
            `{"kind":"table","id":"table-1","__proto__":{"note":"an own key"},"binding":{"kind":"artifact-table","path":"${OUTPUT_PATH}"}}`,
        );

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(field(stamped, "binding", "hash")).toBe(OUTPUT_HASH);
        // A plain assignment at this key reaches the prototype setter, thus the copy would lose the key.
        expect(Object.hasOwn(stamped as object, "__proto__")).toBe(true);
        expect(field(stamped, "__proto__", "note")).toBe("an own key");
        expect(Object.getPrototypeOf(stamped)).toBe(Object.prototype);
    });
});

describe("the intact input", () => {
    it("changes no part of the payload that it read", () => {
        const payload = {
            kind: "section",
            id: "sec-1",
            title: "First",
            blocks: [
                { kind: "text", id: "text-1", content: { prose: "Intro." } },
                { kind: "table", id: "table-1", binding: { kind: "artifact-table", path: OUTPUT_PATH } },
            ],
        };
        const before = structuredClone(payload);

        const stamped = stampReferenceHashes(payload, snapshot)._unsafeUnwrap();

        expect(payload).toEqual(before);
        expect(stamped).not.toBe(payload);
        // The text block sits off the changed path, thus the copy shares that branch with the input.
        expect(field(stamped, "blocks", 0)).toBe(payload.blocks[0]);
    });
});
