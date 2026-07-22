import { describe, test, expect } from "bun:test";

import { createMintPreviewUrlTool } from "./mint-preview-url.js";
import { UnavailablePreviewPublisher, type PreviewMintFailure, type PreviewPublisher } from "./preview-publisher.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";

/** A publisher whose mint fails with whatever the test decides the seam supplied. */
function failingPublisher(failure: PreviewMintFailure): PreviewPublisher {
    return { mintPreviewAccess: async () => failure };
}

function makeTool(previews: PreviewPublisher) {
    return createMintPreviewUrlTool({
        resourceId: "analysis-r",
        previewId: "prv-abc12345",
        currentVersion: 3,
        previews,
        urlCell: { url: undefined, expiresAt: undefined },
    });
}

/**
 * Both directions are asserted because this pins the call site rather than the
 * message helper: a hardcoded "unavailable" string would satisfy the absence
 * checks alone, and only the supplied-status case proves the tool renders the
 * failure the seam actually handed it.
 */
describe("mint_preview_url on a failed mint", () => {
    test("omits a status the seam never supplied", async () => {
        const tool = makeTool(new UnavailablePreviewPublisher());

        const result = await tool.execute({}, makeToolContext().ctx);

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { ok: boolean; error: string };
        expect(value.ok).toBe(false);
        expect(value.error).toBe("preview-access mint failed: report preview is unavailable in this environment");
        expect(value.error).not.toContain("status=");
        expect(value.error).not.toContain("undefined");
    });

    test("carries the status the seam did supply", async () => {
        const tool = makeTool(failingPublisher({ ok: false, status: 503, error: { message: "content server down" } }));

        const result = await tool.execute({}, makeToolContext().ctx);

        const value = result._unsafeUnwrap() as { ok: boolean; error: string };
        expect(value.ok).toBe(false);
        expect(value.error).toBe("preview-access mint failed: status=503 content server down");
    });
});
