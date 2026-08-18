import { describe, expect, it } from "bun:test";

import { computeInputSignature } from "../execution/input-signature.js";
import { decideDataProfileAction, isDataProfileStale, type DataProfileLifecycleStatus } from "./data-profile-policy.js";

const staged = [
    { fileId: "a", size: 10, mtimeMs: 1 },
    { fileId: "b", size: 20, mtimeMs: 2 },
];
const signature = computeInputSignature(staged);

describe("isDataProfileStale", () => {
    it("is never stale when the current input set is empty", () => {
        expect(isDataProfileStale({ fileIds: [] }, { inputFileIds: [] })).toBe(false);
        expect(isDataProfileStale({ fileIds: [] }, { inputFileIds: ["a", "b"] })).toBe(false);
    });

    describe("with a signature on both sides", () => {
        it("is fresh when the digests agree", () => {
            expect(isDataProfileStale({ fileIds: ["a", "b"], signature }, { inputSignature: signature })).toBe(false);
        });

        it("is fresh across enumerations that differ only in order", () => {
            const reversed = computeInputSignature([...staged].reverse());
            expect(isDataProfileStale({ fileIds: ["b", "a"], signature: reversed }, { inputSignature: signature })).toBe(false);
        });

        it("is stale when a file was added", () => {
            const added = computeInputSignature([...staged, { fileId: "c", size: 30, mtimeMs: 3 }]);
            expect(isDataProfileStale({ fileIds: ["a", "b", "c"], signature: added }, { inputSignature: signature })).toBe(true);
        });

        it("is stale when the bytes behind a path changed", () => {
            const edited = computeInputSignature([{ fileId: "a", size: 11, mtimeMs: 99 }, staged[1]!]);
            expect(isDataProfileStale({ fileIds: ["a", "b"], signature: edited }, { inputSignature: signature })).toBe(true);
        });
    });

    describe("with a signature on the snapshot only", () => {
        it("compares what the ids can settle — the count", () => {
            expect(isDataProfileStale({ fileIds: ["a", "b"] }, { inputSignature: signature })).toBe(false);
            expect(isDataProfileStale({ fileIds: ["a", "b", "c"] }, { inputSignature: signature })).toBe(true);
        });
    });

    describe("with a legacy snapshot", () => {
        it("falls back to the identity list rather than treating it as drift", () => {
            expect(isDataProfileStale({ fileIds: ["a", "b"] }, { inputFileIds: ["b", "a"] })).toBe(false);
            expect(isDataProfileStale({ fileIds: ["a", "b"] }, { inputFileIds: ["a", "c"] })).toBe(true);
            expect(isDataProfileStale({ fileIds: ["a"] }, { inputFileIds: ["a", "b"] })).toBe(true);
        });
    });

    it("treats a snapshot carrying neither comparand as drift", () => {
        expect(isDataProfileStale({ fileIds: ["a"] }, {})).toBe(true);
        expect(isDataProfileStale({ fileIds: ["a"] }, null)).toBe(true);
    });
});

describe("decideDataProfileAction", () => {
    const fresh = { current: { fileIds: ["a"] }, profiled: { inputFileIds: ["a"] } };
    const stale = { current: { fileIds: ["a", "b"] }, profiled: { inputFileIds: ["a"] } };

    it("triggers a first profile when pending", () => {
        expect(decideDataProfileAction({ status: "pending", ...fresh }).kind).toBe("trigger");
    });

    it("re-triggers a completed profile whose inputs changed", () => {
        expect(decideDataProfileAction({ status: "completed", ...stale }).kind).toBe("retrigger");
    });

    it("does nothing for a fresh completed profile", () => {
        expect(decideDataProfileAction({ status: "completed", ...fresh }).kind).toBe("none");
    });

    it("does nothing while running or failed", () => {
        for (const status of ["running", "failed"] as DataProfileLifecycleStatus[]) {
            expect(decideDataProfileAction({ status, ...stale }).kind).toBe("none");
        }
    });

    it("does not re-trigger on low coverage alone", () => {
        // A legitimately unclassifiable input set would otherwise re-profile on every
        // parity check. Coverage surfaces on the profile; it never drives the policy.
        const lowCoverage = {
            current: { fileIds: ["a"], signature: computeInputSignature([{ fileId: "a", size: 1, mtimeMs: 1 }]) },
            profiled: {
                inputSignature: computeInputSignature([{ fileId: "a", size: 1, mtimeMs: 1 }]),
                coverage: { matched: 49, unmatched: 3464, total: 3513 },
            },
        };
        expect(decideDataProfileAction({ status: "completed", ...lowCoverage }).kind).toBe("none");
    });
});
