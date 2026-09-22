import { describe, expect, test } from "bun:test";

import { describeSessionPageMintFailure, UnavailableSessionPagePublisher } from "./session-page-publisher.js";

describe("UnavailableSessionPagePublisher", () => {
    test("mintSessionPageAccess gives the unavailable err", async () => {
        const publisher = new UnavailableSessionPagePublisher();
        const failure = (await publisher.mintSessionPageAccess("t1"))._unsafeUnwrapErr();
        expect(failure.error.message).toBe("the hosted view of a session page is unavailable in this environment");
        expect(failure.status).toBeUndefined();
    });
});

describe("describeSessionPageMintFailure", () => {
    test("names only what arrived", () => {
        expect(describeSessionPageMintFailure({ error: {} })).toBe("session-page-access mint failed");
        expect(describeSessionPageMintFailure({ status: 403, error: {} })).toBe("session-page-access mint failed: status=403");
        expect(describeSessionPageMintFailure({ status: 403, error: { message: "no grant" } })).toBe("session-page-access mint failed: status=403 no grant");
        expect(describeSessionPageMintFailure({ error: { message: "  " } })).toBe("session-page-access mint failed");
    });
});
