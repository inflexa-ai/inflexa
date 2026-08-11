import { describe, expect, it } from "bun:test";

import { effectiveDeadlineMs } from "./types.js";

describe("effectiveDeadlineMs", () => {
    it("uses the advertised request-timeout limit when it is larger than the floor", () => {
        expect(effectiveDeadlineMs({ requestTimeoutMs: 900_000 }, 600_000)).toBe(900_000);
    });

    it("uses the floor when the provider advertises nothing", () => {
        expect(effectiveDeadlineMs({}, 600_000)).toBe(600_000);
    });

    it("keeps the floor when the advertised limit is smaller than the floor", () => {
        expect(effectiveDeadlineMs({ requestTimeoutMs: 120_000 }, 600_000)).toBe(600_000);
    });

    it("lets an explicit value override the derived deadline", () => {
        expect(effectiveDeadlineMs({ requestTimeoutMs: 900_000 }, 600_000, 1)).toBe(1);
    });
});
