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
import { withPage, type ChromeConfig } from "../../lib/chrome.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import type { Logger } from "../../lib/logger.js";
import type { PreviewMintResult, PreviewPublisher } from "./preview-publisher.js";
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

const NAV_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 8_000;
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

/** The not-ok arm of the seam's result — what a failed mint is allowed to carry. */
type PreviewMintFailure = Extract<PreviewMintResult, { ok: false }>;

/**
 * The seam's failure shape is sparse by design: a realization with no HTTP
 * transport behind it supplies neither a status nor, necessarily, a message.
 * Naming a field the seam left unset would put the literal `status=undefined`
 * in front of the model, so the message carries only what actually arrived.
 */
function describeMintFailure(failure: PreviewMintFailure): string {
    const detail: string[] = [];
    if (failure.status !== undefined) detail.push(`status=${failure.status}`);
    const message = failure.error.message?.trim();
    if (message) detail.push(message);
    return detail.length > 0 ? `preview-access mint failed: ${detail.join(" ")}` : "preview-access mint failed";
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
                return ok(
                    await withPage(state.chrome, async (page) => {
                        const consoleErrors: string[] = [];
                        const failedRequests: Array<{ url: string; reason: string }> = [];

                        page.on("console", (msg) => {
                            if (msg.type() === "error") consoleErrors.push(msg.text());
                        });
                        page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
                        page.on("requestfailed", (req) => {
                            failedRequests.push({
                                url: req.url(),
                                reason: req.failure()?.errorText ?? "unknown",
                            });
                        });

                        await page.goto(url!, {
                            waitUntil: "networkidle2",
                            timeout: NAV_TIMEOUT_MS,
                        });

                        // Wait for the inflexa-theme-ready event (fired after echarts theme
                        // registers). Check the `__inflexaThemeReady` sentinel first because
                        // the page already deferred its dispatch — by the time we get here
                        // via networkidle2, the event has likely already fired and a plain
                        // addEventListener would block forever. The callback runs in the
                        // browser context.
                        await page
                            .evaluate(
                                new Function(
                                    "timeout",
                                    "return new Promise(function(resolve){if(window.__inflexaThemeReady){resolve();return;}var t=setTimeout(resolve,timeout);document.addEventListener('inflexa-theme-ready',function(){clearTimeout(t);resolve();},{once:true});});",
                                ) as (timeout: number) => Promise<void>,
                                READY_TIMEOUT_MS,
                            )
                            .catch(() => {
                                /* fall through — capture state as-is */
                            });

                        if (input.waitForSelector) {
                            await page.waitForSelector(input.waitForSelector, { timeout: 5_000 }).catch(() => {
                                /* not fatal */
                            });
                        }
                        if (input.waitMs) await new Promise((r) => setTimeout(r, input.waitMs));

                        const screenshot = await page.screenshot({
                            encoding: "base64",
                            fullPage: false,
                        });

                        return {
                            ok: true as const,
                            screenshotBase64: typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64"),
                            consoleErrors,
                            failedRequests,
                        };
                    }),
                );
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
