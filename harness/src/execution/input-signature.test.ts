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

    it("still digests a legacy manifest entry that carries no mtime", () => {
        const legacy = computeInputSignature([
            { fileId: "f-1", size: 100 },
            { fileId: "f-2", size: 200 },
        ]);
        expect(legacy.count).toBe(2);
        expect(legacy.digest).toMatch(/^[0-9a-f]{64}$/);
    });
});
