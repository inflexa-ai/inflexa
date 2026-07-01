import { describe, test, expect } from "bun:test";

import { UnavailablePreviewPublisher } from "./preview-publisher.js";

describe("UnavailablePreviewPublisher", () => {
    test("mintPreviewAccess returns the not-ok unavailable shape", async () => {
        const publisher = new UnavailablePreviewPublisher();
        const result = await publisher.mintPreviewAccess("res-1", "prv-abc");
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("expected not-ok");
        expect(result.error.message).toBe("report preview is unavailable in this environment");
        expect(result.status).toBeUndefined();
    });
});
