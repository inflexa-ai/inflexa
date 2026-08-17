import { describe, expect, test } from "bun:test";

import { describeSessionPageMintFailure, UnavailableSessionPagePublisher } from "./session-page-publisher.js";

describe("UnavailableSessionPagePublisher", () => {
    test("mintSessionPageAccess returns the not-ok unavailable shape", async () => {
        const publisher = new UnavailableSessionPagePublisher();
        const result = await publisher.mintSessionPageAccess("t1");
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected not-ok");
        expect(result.error.message).toBe("the hosted view of a session page is unavailable in this environment");
        expect(result.status).toBeUndefined();
    });
});

describe("describeSessionPageMintFailure", () => {
    test("names only what arrived", () => {
        expect(describeSessionPageMintFailure({ ok: false, error: {} })).toBe("session-page-access mint failed");
        expect(describeSessionPageMintFailure({ ok: false, status: 403, error: {} })).toBe("session-page-access mint failed: status=403");
        expect(describeSessionPageMintFailure({ ok: false, status: 403, error: { message: "no grant" } })).toBe(
            "session-page-access mint failed: status=403 no grant",
        );
        expect(describeSessionPageMintFailure({ ok: false, error: { message: "  " } })).toBe("session-page-access mint failed");
    });
});
