// oxlint-disable-next-line eslint-js/no-restricted-syntax -- the canonical UUIDv5 text form, whose version and variant nibbles pin the minted run id
const UUID_V5_TEXT = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

import { describe, expect, it } from "bun:test";
import { PLAN_ID_RE } from "../../contracts/schemas/chat-parts.js";

import { adHocPlanId, adHocRunId } from "../analysis-invocation.js";

describe("ad hoc invocation identities", () => {
    it("is stable and uses the persisted id shapes", () => {
        expect(adHocPlanId("analysis-1", "call-1")).toMatch(PLAN_ID_RE);
        expect(adHocRunId("analysis-1", "call-1")).toMatch(UUID_V5_TEXT);
        expect(adHocRunId("analysis-1", "call-1")).toBe(adHocRunId("analysis-1", "call-1"));
    });

    it("separates analyses and invocations", () => {
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-1", "call-2"));
        expect(adHocRunId("analysis-1", "call-1")).not.toBe(adHocRunId("analysis-2", "call-1"));
        expect(adHocPlanId("analysis-1", "call-1")).not.toBe(adHocPlanId("analysis-1", "call-2"));
    });
});
