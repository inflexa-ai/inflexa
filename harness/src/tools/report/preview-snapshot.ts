/**
 * preview_snapshot tool — navigate headless Chrome to the rendered report,
 * wait for the `inflexa-theme-ready` event, capture a screenshot + console
 * messages + failed network requests in a single deterministic call.
 *
 * Lazily mints a preview URL via the `PreviewPublisher` seam on first use,
 * sharing the cached URL with the `mint_preview_url` tool via a
 * closure-captured `PreviewUrlCell`.
 *
 * Returned screenshot is base64-encoded PNG bytes; the agent can inspect
 * console errors / failed requests to decide whether to fix the template
 * or move on to submit_report.
 *
 * A seam that cannot mint is also reported through the injected `Logger`:
 * this tool is the build's only visual verification, so an unavailable seam
 * means that verification silently did not happen — a condition an operator
 * has to be able to see without reading the model transcript.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import type { ChromeConfig } from "../../lib/chrome.js";
import { capturePage } from "../../lib/page-capture.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import { describeMintFailure, type PreviewPublisher } from "./preview-publisher.js";
import type { PreviewUrlCell } from "./mint-preview-url.js";

type PreviewSnapshotOutput =
    | {
          ok: false;
          consoleErrors: string[];
          failedRequests: Array<{ url: string; reason: string }>;
          error: string;
      }
    | {
          ok: true;
          screenshotBase64: string;
          consoleErrors: string[];
          failedRequests: Array<{ url: string; reason: string }>;
      };

const WAIT_MS_CAP = 30_000;

export interface PreviewSnapshotToolState {
    readonly resourceId: string;
    readonly previewId: string;
    readonly currentVersion: number;
    readonly previews: PreviewPublisher;
    readonly urlCell: PreviewUrlCell;
    readonly chrome: ChromeConfig;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
}

export function createPreviewSnapshotTool(state: PreviewSnapshotToolState): Tool {
    const logger = (state.logger ?? createNoopLogger()).named("preview-snapshot").with({ previewId: state.previewId });

    return defineTool({
        id: "preview_snapshot",
        description:
            "Render the report in a real headless browser and report what you " +
            "see. Returns a screenshot, console errors, and failed network " +
            "requests. Use this after build_report to verify the layout, charts, " +
            "and data loads correctly.",
        inputSchema: z.object({
            waitForSelector: z
                .string()
                .optional()
                .describe(
                    "Optional CSS selector to wait for after the page is loaded — useful " + "when a specific chart needs to be visible before the screenshot.",
                ),
            waitMs: z
                .number()
                .finite()
                .int()
                .min(0)
                .max(WAIT_MS_CAP)
                .optional()
                .describe("Optional extra wait in ms after the theme-ready event (e.g., for chart paint). Capped at 30s."),
        }),
        describeCall: "none",
        execute: async (input): Promise<Result<PreviewSnapshotOutput, ToolError>> => {
            let url = state.urlCell.url;
            const expiresAt = state.urlCell.expiresAt;
            if (url && expiresAt && new Date(expiresAt).getTime() < Date.now() + 60_000) {
                url = undefined; // refresh if within 60s of expiry
            }

            if (!url) {
                const result = await state.previews.mintPreviewAccess(state.resourceId, state.previewId);
                if (!result.ok) {
                    const reason = result.error.message?.trim();
                    logger.warn("preview access unavailable — visual verification did not run", {
                        version: state.currentVersion,
                        ...(result.status !== undefined ? { status: result.status } : {}),
                        ...(reason ? { reason } : {}),
                    });
                    return ok({
                        ok: false as const,
                        consoleErrors: [] as string[],
                        failedRequests: [] as Array<{ url: string; reason: string }>,
                        error: describeMintFailure(result),
                    });
                }
                url = `${result.data.baseUrl.replace(/\/?$/, "/")}v${state.currentVersion}/index.html?t=${result.data.token}`;
                state.urlCell.url = url;
                state.urlCell.expiresAt = result.data.expiresAt;
            }

            try {
                const captured = await capturePage(state.chrome, url, {
                    ...(input.waitForSelector !== undefined ? { waitForSelector: input.waitForSelector } : {}),
                    ...(input.waitMs !== undefined ? { waitMs: input.waitMs } : {}),
                });
                return ok({
                    ok: true as const,
                    screenshotBase64: captured.screenshotBase64,
                    consoleErrors: captured.consoleErrors,
                    failedRequests: captured.failedRequests,
                });
            } catch (err) {
                return ok({
                    ok: false as const,
                    consoleErrors: [] as string[],
                    failedRequests: [] as Array<{ url: string; reason: string }>,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    });
}
