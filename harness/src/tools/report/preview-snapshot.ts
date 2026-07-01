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
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { withPage, type ChromeConfig } from "../../lib/chrome.js";
import type { PreviewPublisher } from "./preview-publisher.js";
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
}

export function createPreviewSnapshotTool(state: PreviewSnapshotToolState): Tool {
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
                    return ok({
                        ok: false as const,
                        consoleErrors: [] as string[],
                        failedRequests: [] as Array<{ url: string; reason: string }>,
                        error: `preview-access mint failed: status=${result.status} ${result.error.message ?? ""}`.trim(),
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
