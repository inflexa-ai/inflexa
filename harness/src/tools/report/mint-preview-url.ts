/**
 * mint_preview_url tool — get a content-server URL for the report preview.
 *
 * Calls the preview-access seam and returns the full navigatable URL
 * for the requested version.
 *
 * Most callers don't need this — `preview_snapshot` mints lazily on first
 * use. Reach for this tool when:
 *   - the previously-minted URL has expired
 *   - inspecting an older version (pass `version`)
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { PreviewPublisher } from "./preview-publisher.js";

type MintPreviewUrlOutput = { ok: false; error: string } | { ok: true; url: string; expiresAt: string };

/** Shared, mutable URL cell so mint and preview-snapshot share a cached URL. */
export interface PreviewUrlCell {
    url: string | undefined;
    expiresAt: string | undefined;
}

export interface MintPreviewUrlToolState {
    readonly resourceId: string;
    readonly previewId: string;
    readonly currentVersion: number;
    readonly previews: PreviewPublisher;
    readonly urlCell: PreviewUrlCell;
}

export function createMintPreviewUrlTool(state: MintPreviewUrlToolState): Tool {
    return defineTool({
        id: "mint_preview_url",
        description:
            "Mint a fresh preview URL for the report. Returns a content-server " +
            "URL with embedded auth token (15-min TTL). Use this only when you " +
            "need a URL for direct browser navigation — preview_snapshot handles " +
            "the common case automatically.",
        inputSchema: z.object({
            version: z.number().optional().describe("Version to mint for. Defaults to the iteration's current version."),
        }),
        execute: async (input): Promise<Result<MintPreviewUrlOutput, ToolError>> => {
            const version = input.version ?? state.currentVersion;
            const result = await state.previews.mintPreviewAccess(state.resourceId, state.previewId);
            if (!result.ok) {
                return ok({
                    ok: false as const,
                    error: `preview-access mint failed: status=${result.status} ${result.error.message ?? ""}`.trim(),
                });
            }
            const url = `${result.data.baseUrl.replace(/\/?$/, "/")}v${version}/index.html?t=${result.data.token}`;
            state.urlCell.url = url;
            state.urlCell.expiresAt = result.data.expiresAt;
            return ok({
                ok: true as const,
                url,
                expiresAt: result.data.expiresAt,
            });
        },
    });
}
