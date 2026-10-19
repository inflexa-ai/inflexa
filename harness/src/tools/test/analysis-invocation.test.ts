import { describe, expect, it } from "bun:test";

import { isPlanId } from "../../contracts/ids.js";
import { isLowerHex } from "../../lib/text.js";
import { adHocPlanId, adHocRunId } from "../analysis-invocation.js";

/** The ad-hoc run id: the UUID layout with the version nibble pinned to 5 and the RFC variant nibble. */
function isVersion5Uuid(value: string): boolean {
    return (
        value.length === 36 &&
        isLowerHex(value.slice(0, 8)) &&
        value[8] === "-" &&
        isLowerHex(value.slice(9, 13)) &&
        value[13] === "-" &&
        value[14] === "5" &&
        isLowerHex(value.slice(15, 18)) &&
        value[18] === "-" &&
        (value[19] === "8" || value[19] === "9" || value[19] === "a" || value[19] === "b") &&
        isLowerHex(value.slice(20, 23)) &&
        value[23] === "-" &&
        isLowerHex(value.slice(24))
    );
}

describe("ad hoc invocation identities", () => {
    it("is stable and uses the persisted id shapes", () => {
        expect(isPlanId(adHocPlanId("analysis-1", "call-1"))).toBe(true);
        expect(isVersion5Uuid(adHocRunId("analysis-1", "call-1"))).toBe(true);
        expect(adHocRunId("analysis-1", "call-1")).toBe(adHocRunId("analysis-1", "call-1"));
    });

    it("separates analyses and invocations", () => {
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-1", "call-2"));
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-2", "call-1"));
        expect(adHocPlanId("analysis-1", "call-1")).not.toBe(adHocPlanId("analysis-1", "call-2"));
    });
});
