import { describe, expect, it } from "bun:test";

import { decideDataProfileAction, isDataProfileStale, type DataProfileLifecycleStatus } from "./data-profile-policy.js";

describe("isDataProfileStale", () => {
    it("is never stale when the seed set is empty", () => {
        expect(isDataProfileStale([], [])).toBe(false);
        expect(isDataProfileStale([], ["a", "b"])).toBe(false);
    });

    it("is fresh when the sets cover the same ids (order-independent)", () => {
        expect(isDataProfileStale(["a", "b"], ["b", "a"])).toBe(false);
    });

    it("is stale when an input was added", () => {
        expect(isDataProfileStale(["a", "b", "c"], ["a", "b"])).toBe(true);
    });

    it("is stale when an input was swapped (same count, different members)", () => {
        expect(isDataProfileStale(["a", "b"], ["a", "c"])).toBe(true);
    });

    it("is stale when an input was removed from the seed set", () => {
        expect(isDataProfileStale(["a"], ["a", "b"])).toBe(true);
    });
});

describe("decideDataProfileAction", () => {
    const fresh = { seedInputFileIds: ["a"], profiledInputFileIds: ["a"] };
    const stale = { seedInputFileIds: ["a", "b"], profiledInputFileIds: ["a"] };

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
});
