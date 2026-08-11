import { describe, expect, it } from "bun:test";

import { effectivePlanTimeoutMs } from "./generate-plan.js";

/** The default wall-clock guard, `PLAN_TIMEOUT_MS`, in milliseconds. */
const PLAN_TIMEOUT_MS = 600_000;

describe("effective plan wall-clock guard", () => {
    it("uses the advertised request-timeout limit when it is larger than the constant", () => {
        expect(effectivePlanTimeoutMs({ requestTimeoutMs: 900_000 })).toBe(900_000);
    });

    it("uses the default constant when the provider advertises nothing", () => {
        expect(effectivePlanTimeoutMs({})).toBe(PLAN_TIMEOUT_MS);
    });

    it("keeps the constant when the advertised limit is smaller than the constant", () => {
        expect(effectivePlanTimeoutMs({ requestTimeoutMs: 120_000 })).toBe(PLAN_TIMEOUT_MS);
    });
});
