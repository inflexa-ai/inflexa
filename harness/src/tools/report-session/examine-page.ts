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
 * The `file://` URL resolves on the filesystem of the Chrome sidecar, because the connection is out of
 * process. Thus the sidecar must mount the workspace tree of the harness host at the same path. A sidecar
 * with no such mount reports the page as an unreachable request, and the tool gives back that fault.
 *
 * A composition that names no browser and injects no capture seam has no eyes at all. The tool reports that
 * condition once, up front, and it stamps nothing. A per-attempt capture failure would instead read as a
 * transient fault and invite a repeat of a call that can never pass.
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

import { hasBrowserUrl, type ChromeConfig } from "../../lib/chrome.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { capturePage, type CapturePage, type FailedRequest, type PageCapture } from "../../lib/page-capture.js";
import type { ResolveWorkspaceRoot } from "../../workspace/paths.js";
import { defineTool, withToolResultImage, type Tool, type ToolError } from "../define-tool.js";
import { openReportThread, type ReportSessionStateGateway, type SessionRefusal } from "../report-authoring/authoring-tools.js";

// The capture shapes live beside the chrome connection, because two tools capture the same page. The tool
// keeps them on its own surface, thus a consumer of the tool imports one module.
export type { CapturePage, FailedRequest, PageCapture };

/** The empty input. The tool examines the current page of the thread, thus it needs no field. */
const examinePageInput = z.object({});

export type ExaminePageInput = z.infer<typeof examinePageInput>;

/**
 * The typed outcome of the eyes tool. Each arm is ok-channel data, thus the tool never throws for a
 * degraded condition. `examined` carries the console errors, the failed requests, and the page path. The
 * screenshot does not ride the JSON. It rides the image path of the tool result, thus the model sees the
 * picture and the JSON text holds no bytes. `missed-stamp` means that the row holds no rendered hash, thus
 * no preview stamped one and the agent must run a new preview before the next look. `no-browser` means that
 * the composition gives no browser, thus no look is possible at all and a repeat gives the same answer.
 */
export type ExaminePageResult =
    | { outcome: "refused"; refusal: SessionRefusal }
    | { outcome: "no-browser"; detail: string }
    | { outcome: "no-page" }
    | { outcome: "missed-stamp" }
    | { outcome: "capture-failed"; detail: string }
    | { outcome: "examined"; consoleErrors: string[]; failedRequests: FailedRequest[]; pagePath: string };

/**
 * The construction deps of the eyes tool.
 *
 * `resolveWorkspaceRoot` maps the analysis of the call onto its workspace root, thus one singleton tool
 * serves every analysis. `chrome` configures the headless browser, and the sidecar that it names must mount
 * the workspace tree at the same path, because the tool navigates to a `file://` URL. `capture` is optional
 * and defaults to the shared capture, thus a test injects a seam that reads no browser.
 */
export interface ExaminePageToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly chrome: ChromeConfig;
    readonly capture?: CapturePage;
    readonly logger?: Logger;
}

/** The IANA media type of the screenshot. `page.screenshot` gives PNG bytes. */
const SCREENSHOT_MEDIA_TYPE = "image/png";

/** The line that the agent reads when the composition gives no browser. */
const NO_BROWSER_DETAIL = "the composition gives no browser, thus this session cannot look at its page";

/**
 * Make the eyes tool over the session-state gateway, the workspace-root seam, and the chrome config.
 *
 * The tool reads the thread id from the scope of the call, and it resolves the page path under the workspace
 * root. Thus one factory serves every thread. The tool holds no per-session value.
 */
export function createExaminePageTool(deps: ExaminePageToolDeps): Tool<ExaminePageInput, ExaminePageResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("examine-page");
    // An injected seam is the eyes of a test. A named browser is the eyes of a deployment. With neither, the
    // composition has no eyes, and that answer is fixed at construction.
    const eyesAvailable = deps.capture !== undefined || hasBrowserUrl(deps.chrome);
    const capture: CapturePage = deps.capture ?? ((url) => capturePage(deps.chrome, url));

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
            // The check runs before every read, thus one clear signal replaces a capture failure for each
            // page. The arm stamps no seen hash, because no eyes saw the page.
            if (!eyesAvailable) {
                logger.warn("the composition gives no browser, thus no look can run");
                return ok({ outcome: "no-browser", detail: NO_BROWSER_DETAIL });
            }

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

            const relativePagePath = join("report-sessions", threadId, "index.html");
            const pagePath = join(root, relativePagePath);
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

            // The screenshot rides the image path of the tool result, thus the model sees the picture. The
            // JSON keeps the faults and the page path only, thus the JSON text holds no bytes.
            return ok(
                withToolResultImage(
                    {
                        outcome: "examined" as const,
                        consoleErrors: captured.consoleErrors,
                        failedRequests: captured.failedRequests,
                        pagePath: relativePagePath,
                    },
                    { base64: captured.screenshotBase64, mediaType: SCREENSHOT_MEDIA_TYPE },
                ),
            );
        },
    });
}
