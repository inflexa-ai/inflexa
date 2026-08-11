/**
 * The eyes tool of a report session.
 *
 * The tool opens the rendered page of a thread in headless Chrome, and it gives back what a reviewer would
 * see: the screenshot, the console errors, and the failed requests. The agent reads the picture and the
 * faults, decides, and repairs. The tool never judges, thus it never blocks the loop.
 *
 * The session tree has no URL space, thus the tool navigates to the page file through a `file://` URL. The
 * page lives at `report-sessions/{threadId}/index.html` under the workspace root, which the preview writes.
 * A missed page means that no preview ran, and it is a typed outcome, not a throw.
 *
 * On a capture the tool copies the rendered hash onto the seen hash through the gateway. Thus the look
 * counts, and the record tool lets the current draft record. The copy takes the rendered hash and never the
 * current one, thus a later edit makes the look stale and the record refuses.
 *
 * The gateway reports whether a rendered hash existed to copy. When the row holds none, no preview stamped
 * one and the look cannot count. The tool then gives a missed-stamp outcome that directs a new preview,
 * because a repeated look never stamps a marker that no preview wrote.
 *
 * The chrome navigation and the workspace-root seam each speak the throw protocol. The tool runs the capture
 * inside a guard, thus a genuine fault becomes a typed outcome and a control-flow exception propagates.
 */

import { ok, type Result } from "neverthrow";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { withPage, type ChromeConfig } from "../../lib/chrome.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import type { ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";

/** One request that the page could not load, with the reason that the browser gave. */
export interface FailedRequest {
    url: string;
    reason: string;
}

/** The picture and the faults of one page capture. */
export interface PageCapture {
    screenshotBase64: string;
    consoleErrors: string[];
    failedRequests: FailedRequest[];
}

/**
 * The capture seam. It navigates to a page URL, and it gives back the screenshot and the faults. The seam
 * speaks the throw protocol, because the chrome connection does. A test injects a seam that reads no
 * browser, thus the tool orchestration runs with no chrome sidecar.
 */
export type CapturePage = (url: string) => Promise<PageCapture>;

/** The empty input. The tool examines the current page of the thread, thus it needs no field. */
const examinePageInput = z.object({});

export type ExaminePageInput = z.infer<typeof examinePageInput>;

/**
 * The typed outcome of the eyes tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition. `examined` carries the screenshot, the console errors, and the failed requests.
 * `missed-stamp` means that the row holds no rendered hash, thus no preview stamped one and the agent must
 * run a new preview before the next look.
 */
export type ExaminePageResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "no-page" }
    | { outcome: "missed-stamp" }
    | { outcome: "capture-failed"; detail: string }
    | { outcome: "examined"; screenshotBase64: string; consoleErrors: string[]; failedRequests: FailedRequest[] };

/**
 * The construction deps of the eyes tool.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root, thus one singleton tool
 * serves every analysis. `chrome` configures the headless browser. `capture` is optional and defaults to a
 * realization over `withPage`, thus a test injects a seam that reads no browser.
 */
export interface ExaminePageToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly chrome: ChromeConfig;
    readonly capture?: CapturePage;
    readonly logger?: Logger;
}

const NAV_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 8_000;

/**
 * The default capture over `withPage`. It collects the console errors, the page errors, and the failed
 * requests, then it waits for the theme-ready event and captures the screenshot. The event fires after the
 * page registers its chart theme, thus the picture shows the painted charts. The wait is best-effort, thus a
 * page with no event still captures.
 */
function chromeCapture(chrome: ChromeConfig): CapturePage {
    return (url) =>
        withPage(chrome, async (page) => {
            const consoleErrors: string[] = [];
            const failedRequests: FailedRequest[] = [];

            page.on("console", (msg) => {
                if (msg.type() === "error") consoleErrors.push(msg.text());
            });
            page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
            page.on("requestfailed", (req) => {
                failedRequests.push({ url: req.url(), reason: req.failure()?.errorText ?? "unknown" });
            });

            await page.goto(url, { waitUntil: "networkidle2", timeout: NAV_TIMEOUT_MS });

            // The theme-ready event fires after the chart theme registers. The `__inflexaThemeReady`
            // sentinel guards a page that already dispatched the event before this wait, thus a plain
            // listener does not block forever. The callback runs in the browser context.
            await page
                .evaluate(
                    new Function(
                        "timeout",
                        "return new Promise(function(resolve){if(window.__inflexaThemeReady){resolve();return;}var t=setTimeout(resolve,timeout);document.addEventListener('inflexa-theme-ready',function(){clearTimeout(t);resolve();},{once:true});});",
                    ) as (timeout: number) => Promise<void>,
                    READY_TIMEOUT_MS,
                )
                .catch(() => {
                    /* the picture captures as it stands */
                });

            const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
            return {
                screenshotBase64: typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64"),
                consoleErrors,
                failedRequests,
            };
        });
}

/**
 * Make the eyes tool over the session-state gateway, the workspace-root seam, and the chrome config.
 *
 * The tool reads the thread id from the scope of the call, and it resolves the page path under the workspace
 * root. Thus one factory serves every thread. The tool holds no per-session value.
 */
export function createExaminePageTool(deps: ExaminePageToolDeps): Tool<ExaminePageInput, ExaminePageResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("examine-page");
    const capture = deps.capture ?? chromeCapture(deps.chrome);

    return defineTool({
        id: "examine_page",
        description:
            "Open the rendered report page in a real headless browser, and report what you see. " +
            "Give back a screenshot, the console errors, and the failed requests. " +
            "Run it after the preview to look at the current page, and to confirm that the layout and the charts read clean. " +
            "The report tool records a version only after you look at the current page. " +
            "If the page has no confirmed render, run the preview again first.",
        inputSchema: examinePageInput,
        executionMode: "inline",
        describeCall: "none",
        execute: async (_input, ctx): Promise<Result<ExaminePageResult, ToolError>> => {
            const opened = await openReportThread(deps.gateway, ctx.session.scope);
            if (opened.isErr()) {
                return ok({ outcome: "refused", refusal: opened.error });
            }
            const { threadId, analysisId } = opened.value;

            let root: string;
            try {
                root = deps.resolveWorkspaceRoot(analysisId);
            } catch (cause) {
                logger.warn("the workspace root did not resolve", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "capture-failed", detail: "the workspace root did not resolve" });
            }

            const pagePath = join(root, "report-sessions", threadId, "index.html");
            try {
                await access(pagePath);
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
                    // No preview wrote the page yet. The agent runs the preview first.
                    return ok({ outcome: "no-page" });
                }
                logger.warn("the session page could not be read", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "capture-failed", detail: "the session page could not be read" });
            }

            let captured: PageCapture;
            try {
                captured = await capture(pathToFileURL(pagePath).href);
            } catch (cause) {
                logger.warn("the page capture failed", { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "capture-failed", detail: cause instanceof Error ? cause.message : String(cause) });
            }

            const stamped = await deps.gateway.stampSeen(threadId);
            if (stamped.outcome === "no-rendered") {
                // The row holds no rendered hash, thus no preview stamped one and the look cannot count. A
                // repeated look never fixes this, because it copies a marker that no preview wrote. The agent
                // runs a new preview, which stamps the rendered hash for the next look.
                logger.warn("the seen stamp found no rendered hash", { threadId, analysisId });
                return ok({ outcome: "missed-stamp" });
            }
            // A transient stamp fault and an absent row each leave the seen hash short, and the record gate
            // then refuses a never-seen page. A later look re-stamps the marker, thus the picture stays valid
            // and the tool gives it back.
            if (stamped.outcome !== "stamped") {
                const detail = stamped.outcome === "failed" ? stamped.detail : "the session state row is absent";
                logger.warn("the seen hash did not stamp", { threadId, analysisId, detail });
            }

            return ok({
                outcome: "examined",
                screenshotBase64: captured.screenshotBase64,
                consoleErrors: captured.consoleErrors,
                failedRequests: captured.failedRequests,
            });
        },
    });
}
