import { describe, expect, it } from "bun:test";

import { adHocPlanId, adHocRunId } from "./analysis-invocation.js";

describe("ad hoc invocation identities", () => {
    it("is stable and uses the persisted id shapes", () => {
        expect(adHocPlanId("analysis-1", "call-1")).toMatch(/^pln-[a-f0-9]{8}$/);
        expect(adHocRunId("analysis-1", "call-1")).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
        expect(adHocRunId("analysis-1", "call-1")).toBe(adHocRunId("analysis-1", "call-1"));
    });

    it("separates analyses and invocations", () => {
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-1", "call-2"));
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-2", "call-1"));
        expect(adHocPlanId("analysis-1", "call-1")).not.toBe(adHocPlanId("analysis-1", "call-2"));
    });
});
