import { describe, expect, it } from "bun:test";

import { computeInputSignature } from "./input-signature.js";

const inputs = [
    { fileId: "f-1", size: 100, mtimeMs: 1_700_000_000_000 },
    { fileId: "f-2", size: 200, mtimeMs: 1_700_000_000_001 },
    { fileId: "f-3", size: 300, mtimeMs: 1_700_000_000_002 },
];

describe("computeInputSignature", () => {
    it("counts the staged inputs and digests their identity", () => {
        const signature = computeInputSignature(inputs);
        expect(signature.count).toBe(3);
        expect(signature.digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is order-independent", () => {
        const forwards = computeInputSignature(inputs);
        const backwards = computeInputSignature([...inputs].reverse());
        expect(forwards.digest).toBe(backwards.digest);
        expect(forwards.count).toBe(backwards.count);
    });

    it("changes when a file is added", () => {
        const before = computeInputSignature(inputs);
        const after = computeInputSignature([...inputs, { fileId: "f-4", size: 400, mtimeMs: 1_700_000_000_003 }]);
        expect(after.digest).not.toBe(before.digest);
        expect(after.count).toBe(4);
    });

    it("changes when the same path holds different bytes", () => {
        const before = computeInputSignature(inputs);
        const edited = computeInputSignature([{ ...inputs[0]!, size: 101, mtimeMs: 1_700_000_100_000 }, inputs[1]!, inputs[2]!]);
        expect(edited.digest).not.toBe(before.digest);
        expect(edited.count).toBe(before.count);
    });

    it("ignores a quarantined file appearing beside the staged inputs", () => {
        const staged = inputs.map((f, i) => ({ ...f, relativePath: `inputs/mount/file-${i}.csv` }));
        const churned = [...staged, { fileId: "f-junk", size: 7, mtimeMs: 1_700_000_500_000, relativePath: "inputs/mount/file-0.csv.part" }];

        expect(computeInputSignature(churned)).toEqual(computeInputSignature(staged));
    });

    it("ignores a quarantined file changing size and mtime", () => {
        const junk = { fileId: "f-junk", size: 7, mtimeMs: 1_700_000_500_000, relativePath: "inputs/mount/.DS_Store" };
        const staged = inputs.map((f, i) => ({ ...f, relativePath: `inputs/mount/file-${i}.csv` }));

        const before = computeInputSignature([...staged, junk]);
        const after = computeInputSignature([...staged, { ...junk, size: 9000, mtimeMs: 1_700_009_000_000 }]);
        expect(after).toEqual(before);
    });

    it("detects a kept file arriving even while junk churns", () => {
        const staged = inputs.map((f, i) => ({ ...f, relativePath: `inputs/mount/file-${i}.csv` }));
        const grown = [...staged, { fileId: "f-4", size: 400, mtimeMs: 1_700_000_000_003, relativePath: "inputs/mount/file-3.csv" }];

        expect(computeInputSignature(grown).digest).not.toBe(computeInputSignature(staged).digest);
        expect(computeInputSignature(grown).count).toBe(4);
    });

    it("counts and digests kept files only", () => {
        const signature = computeInputSignature([
            { fileId: "f-1", size: 100, mtimeMs: 1, relativePath: "inputs/mount/a.csv" },
            { fileId: "f-2", size: 200, mtimeMs: 2, relativePath: "inputs/mount/__MACOSX/a.csv" },
            { fileId: "f-3", size: 300, mtimeMs: 3, relativePath: "inputs/mount/b.csv.tmp-0123abcd" },
        ]);
        expect(signature.count).toBe(1);
    });

    it("is order-independent with quarantine applied", () => {
        const mixed = [
            { fileId: "f-1", size: 100, mtimeMs: 1, relativePath: "inputs/mount/a.csv" },
            { fileId: "f-junk", size: 5, mtimeMs: 2, relativePath: "inputs/mount/a.csv.crdownload" },
            { fileId: "f-2", size: 200, mtimeMs: 3, relativePath: "inputs/mount/b.csv" },
        ];
        expect(computeInputSignature([...mixed].reverse())).toEqual(computeInputSignature(mixed));
    });

    it("keeps an entry that names no path, so a pathless manifest still compares", () => {
        const pathless = computeInputSignature([{ fileId: "f-1", size: 100, mtimeMs: 1 }]);
        expect(pathless.count).toBe(1);
    });

    it("still digests a legacy manifest entry that carries no mtime", () => {
        const legacy = computeInputSignature([
            { fileId: "f-1", size: 100 },
            { fileId: "f-2", size: 200 },
        ]);
        expect(legacy.count).toBe(2);
        expect(legacy.digest).toMatch(/^[0-9a-f]{64}$/);
    });
});
