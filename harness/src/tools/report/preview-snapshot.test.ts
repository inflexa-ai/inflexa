import { describe, test, expect } from "bun:test";

import { createPreviewSnapshotTool } from "./preview-snapshot.js";
import { UnavailablePreviewPublisher, type PreviewMintResult, type PreviewPublisher } from "./preview-publisher.js";
import { makeToolContext } from "../__fixtures__/tool-context.js";
import { createCapturingLogger } from "../../__tests__/setup/logger.js";

const PREVIEW_ID = "prv-abc12345";

/** A publisher whose mint fails with whatever the test decides the seam supplied. */
function failingPublisher(failure: Extract<PreviewMintResult, { ok: false }>): PreviewPublisher {
    return { mintPreviewAccess: async () => failure };
}

function makeTool(previews: PreviewPublisher, logger: ReturnType<typeof createCapturingLogger>) {
    return createPreviewSnapshotTool({
        resourceId: "analysis-r",
        previewId: PREVIEW_ID,
        currentVersion: 3,
        previews,
        urlCell: { url: undefined, expiresAt: undefined },
        // No browser is reachable in a unit test; a failed mint short-circuits
        // before any Chrome connection, which is what makes that safe.
        chrome: {},
        logger,
    });
}

describe("preview_snapshot with an unavailable preview seam", () => {
    test("returns ok:false, warns through the injected logger, and names no absent status", async () => {
        const logger = createCapturingLogger();
        const tool = makeTool(new UnavailablePreviewPublisher(), logger);

        const result = await tool.execute({}, makeToolContext().ctx);

        expect(result.isOk()).toBe(true);
        const value = result._unsafeUnwrap() as { ok: boolean; error: string };
        expect(value.ok).toBe(false);
        expect(value.error).toContain("preview-access mint failed");
        expect(value.error).toContain("report preview is unavailable in this environment");
        // The local seam carries no HTTP status — the message must not invent one.
        expect(value.error).not.toContain("status=");
        expect(value.error).not.toContain("undefined");

        expect(logger.records).toHaveLength(1);
        const record = logger.records[0];
        expect(record.level).toBe("warn");
        expect(record.msg).toContain("[preview-snapshot]");
        expect(record.fields.previewId).toBe(PREVIEW_ID);
        expect(record.fields.version).toBe(3);
        expect(record.fields.reason).toBe("report preview is unavailable in this environment");
        expect(record.fields).not.toHaveProperty("status");
    });

    test("carries the status the seam did supply into both message and record", async () => {
        const logger = createCapturingLogger();
        const tool = makeTool(failingPublisher({ ok: false, status: 503, error: { message: "content server down" } }), logger);

        const result = await tool.execute({}, makeToolContext().ctx);

        const value = result._unsafeUnwrap() as { ok: boolean; error: string };
        expect(value.ok).toBe(false);
        expect(value.error).toBe("preview-access mint failed: status=503 content server down");
        expect(logger.records[0].fields.status).toBe(503);
    });

    test("degrades to the bare failure line when the seam supplies nothing", async () => {
        const logger = createCapturingLogger();
        const tool = makeTool(failingPublisher({ ok: false, error: {} }), logger);

        const result = await tool.execute({}, makeToolContext().ctx);

        const value = result._unsafeUnwrap() as { ok: boolean; error: string };
        expect(value.error).toBe("preview-access mint failed");
        expect(logger.records[0].fields).not.toHaveProperty("reason");
    });
});
