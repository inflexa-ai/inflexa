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
 * The composition says where a browser comes from, and the eyes seam is that answer. One look acquires one
 * lease, and the tool captures against the endpoint of that lease.
 *
 * The `file://` URL resolves on the filesystem of the browser, because the connection is out of process.
 * Thus the browser of a lease must hold the workspace tree of the harness host at the same path. A browser
 * with no such mount reports the page as an unreachable request, and the tool gives back that fault.
 *
 * The tool releases the lease after the look. The release runs on a pass and on a failed capture alike. That
 * release is hygiene, and it is not the guarantee against a leak. A process can die between the acquire and
 * the release, thus the realization bounds the life of what it provisions. As a result a failed release
 * changes no outcome, and the log is its whole record.
 *
 * A composition with no capture seam, no eyes seam, and no configured endpoint has no eyes at all. The tool
 * reports that condition one time, up front, and it stamps nothing. A per-attempt capture failure would
 * instead read as a transient fault, and it would invite a repeat of a call that can never pass.
 *
 * On a capture the tool copies the rendered hash onto the seen hash through the gateway. Thus the look
 * counts, and the record tool lets the current draft record. The copy takes the rendered hash and never the
 * current one, thus a later edit makes the look stale and the record refuses.
 *
 * The gateway reports whether a rendered hash existed to copy. When the row holds none, no preview stamped
 * one and the look cannot count. The tool then gives a missed-stamp outcome that directs a new preview,
 * because a repeated look never stamps a marker that no preview wrote.
 *
 * The eyes seam, the chrome navigation, and the workspace-root seam each speak the throw protocol. The tool
 * guards each of them, thus a fault of a look becomes a typed outcome and the loop never sees a throw.
 *
 * A hang is not a throw, and a guard alone never ends one. Thus the acquire and the release each carry a
 * deadline. A realization that hangs while it starts a browser would otherwise hold the whole agent turn,
 * and no outcome would ever arrive.
 */

import { err, ok, type Result } from "neverthrow";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { hasBrowserUrl, type ChromeConfig } from "../../lib/chrome.js";
import { createNoopLogger } from "../../lib/console-logger.js";
import { createStaticEyes, type AcquireEyes, type EyesLease, type EyesScope } from "../../lib/eyes.js";
import { defaultErrorFields, type Logger } from "../../lib/logger.js";
import { capturePage, type CapturePage, type FailedRequest, type PageCapture } from "../../lib/page-capture.js";
import { reportSessionDir, type ResolveWorkspaceRoot } from "../../workspace/paths.js";
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
 * serves every analysis. `eyes` gives a browser for one look, and the scope of the acquire carries that
 * analysis and its root. `chrome` carries the connection settings of the capture, and the browser that it
 * names must hold the workspace tree at the same path, because the tool navigates to a `file://` URL.
 * `capture` is optional and it replaces the whole transport, thus a test injects a seam that reads no
 * browser.
 */
export interface ExaminePageToolDeps {
    readonly gateway: ReportSessionStateGateway;
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    readonly chrome: ChromeConfig;
    readonly eyes?: AcquireEyes;
    readonly capture?: CapturePage;
    readonly logger?: Logger;
    /**
     * The two budgets of one look, in milliseconds. A test seam: it shortens the budgets, thus a hung
     * realization settles inside one test run. Absent, the tool reads {@link ACQUIRE_DEADLINE_MS} and
     * {@link RELEASE_DEADLINE_MS}, which no composition tunes.
     */
    readonly deadlines?: { readonly acquireMs?: number; readonly releaseMs?: number };
}

/**
 * The transport of one look, fixed at construction.
 *
 * `capture` replaces the whole transport, thus that arm acquires no lease at all. `lease` reaches a browser
 * through the eyes seam, and each look takes one lease. The two arms are the eyes of the composition.
 */
type ResolvedEyes = { readonly kind: "capture"; readonly capture: CapturePage } | { readonly kind: "lease"; readonly acquire: AcquireEyes };

/** The transport, or the absent one. `none` means that the composition gives no route to a browser at all. */
type EyesTransport = ResolvedEyes | { readonly kind: "none" };

/**
 * Resolve the transport of the tool from its deps, one time.
 *
 * The precedence is `capture`, then `eyes`, then the chrome config as static eyes. An injected capture wins
 * over the two others, because it replaces the whole transport and a test injects it.
 *
 * The chrome arm serves a direct construction alone, for example the tests of this file. The assembled
 * runtime wraps the configured endpoint into the static realization at its composition root. Thus one wrap
 * serves that runtime, and this arm never fires there.
 */
function resolveEyes(deps: ExaminePageToolDeps): EyesTransport {
    if (deps.capture !== undefined) {
        return { kind: "capture", capture: deps.capture };
    }
    if (deps.eyes !== undefined) {
        return { kind: "lease", acquire: deps.eyes };
    }
    if (hasBrowserUrl(deps.chrome)) {
        return { kind: "lease", acquire: createStaticEyes(deps.chrome) };
    }
    return { kind: "none" };
}

/** The stage of a look that raised a fault. Each stage logs its own line, and both give one outcome. */
type LookStage = "acquire" | "capture";

/** A fault of one look: the stage that raised it, and the cause that it raised. */
interface LookFault {
    readonly stage: LookStage;
    readonly cause: unknown;
}

/** The log line of each stage. The outcome of the tool is one arm, thus the stage rides in the log alone. */
const LOOK_FAULT_MESSAGE: Record<LookStage, string> = {
    acquire: "the eyes gave no browser for the look",
    capture: "the page capture failed",
};

/**
 * The deadline of one acquire, in milliseconds.
 *
 * A realization can start a container and boot a browser inside it, and that cold start costs seconds. The
 * budget covers a slow cold start with a wide margin. It also ends a realization that hangs: one look sits
 * inside one agent turn, and a hung acquire holds that whole turn with no outcome at all.
 */
const ACQUIRE_DEADLINE_MS = 60_000;

/**
 * The deadline of one release, in milliseconds.
 *
 * A release stops what one acquire started, and the look already holds its picture. Thus the budget is short.
 * A release that runs past the budget costs nothing, because the realization bounds the life of what it
 * provisions.
 */
const RELEASE_DEADLINE_MS = 10_000;

/** The fault of one operation that ran against a deadline: the cause that it raised, or the expiry. */
type DeadlineFault = { readonly kind: "threw"; readonly cause: unknown } | { readonly kind: "expired" };

/** The win of the timer arm. A symbol cannot collide with a value that the operation gives. */
const EXPIRED = Symbol("expired");

/**
 * Run one operation against a deadline, and give the value, the cause, or the expiry.
 *
 * The eyes seam takes no abort signal, thus a race is the whole bound. The loser of the race stays in
 * flight, and the caller of an expired operation owns whatever arrives late.
 *
 * Each path clears the timer. `sleep` of `async-utils.ts` holds a timer that nothing can clear. Thus an
 * operation that wins its race would still keep the process alive for the rest of the budget.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<Result<T, DeadlineFault>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The settled arm never rejects. Thus a fault that arrives after the expiry stays contained here, and it
    // never reaches the process as an unhandled rejection.
    const settled: Promise<Result<T, DeadlineFault>> = work.then(
        (value) => ok(value),
        (cause: unknown) => err({ kind: "threw" as const, cause }),
    );
    const expiry = new Promise<typeof EXPIRED>((resolve) => {
        timer = setTimeout(() => resolve(EXPIRED), ms);
    });
    const winner = await Promise.race([settled, expiry]);
    clearTimeout(timer);
    return winner === EXPIRED ? err({ kind: "expired" }) : winner;
}

/** The cause of one such fault. An expiry names its budget, thus the detail of the outcome names it too. */
function faultCause(fault: DeadlineFault, expiry: string, ms: number): unknown {
    return fault.kind === "threw" ? fault.cause : new Error(`${expiry} within ${ms} ms`);
}

/**
 * Start one seam call, and give the promise of its outcome.
 *
 * A realization comes from the embedder, and one that is hand-written can throw before it gives its promise.
 * The catch turns that throw into a rejection. Thus the deadline below reads one shape, and a look keeps the
 * no-throw contract of the tool.
 */
function startSeamCall<T>(call: () => Promise<T>): Promise<T> {
    try {
        return call();
    } catch (cause) {
        return Promise.reject(cause);
    }
}

/**
 * Release a lease that arrived after the deadline of its acquire.
 *
 * The acquire stays in flight past that deadline, thus a browser can still arrive with no owner. The
 * realization bounds the life of that browser, and this release ends it sooner. The look already gave its
 * outcome, thus a fault here reaches the log alone.
 */
function releaseLateLease(pending: Promise<EyesLease>, logger: Logger): void {
    void pending
        .then((lease) => lease.release())
        .catch((cause: unknown) => {
            logger.warn("the eyes lease did not release", logger.errorFields(cause));
        });
}

/**
 * Run one look over the resolved transport, and give the picture or the typed fault.
 *
 * The lease arm acquires one browser, captures against the endpoint of that lease, and releases in a
 * `finally`. Thus a failed capture releases too. The shared capture takes a chrome config, thus the endpoint
 * of the lease replaces the configured one and each other field of the composition stays.
 *
 * A failed release changes no outcome of the look. The capture already ran, and the realization bounds the
 * life of what it provisions. Thus the log is the whole record of a failed release.
 *
 * The two seam calls each run against a deadline. An expired acquire reads as an acquire fault, thus a hung
 * realization gives the same outcome as a refused one. An expired release reads as a failed release, thus it
 * reaches the log and it changes no outcome.
 */
async function runLook(args: {
    readonly transport: ResolvedEyes;
    readonly chrome: ChromeConfig;
    readonly scope: EyesScope;
    readonly url: string;
    readonly acquireMs: number;
    readonly releaseMs: number;
    readonly logger: Logger;
}): Promise<Result<PageCapture, LookFault>> {
    const { transport } = args;
    if (transport.kind === "capture") {
        try {
            return ok(await transport.capture(args.url));
        } catch (cause) {
            return err({ stage: "capture", cause });
        }
    }

    // The pending acquire stays apart from its deadline. An expiry leaves the acquire in flight, and a lease
    // that arrives late still gets a release.
    const pending = startSeamCall(() => transport.acquire(args.scope));
    const acquired = await withDeadline(pending, args.acquireMs);
    if (acquired.isErr()) {
        if (acquired.error.kind === "expired") releaseLateLease(pending, args.logger);
        return err({ stage: "acquire", cause: faultCause(acquired.error, "the eyes gave no browser", args.acquireMs) });
    }
    const lease = acquired.value;
    try {
        return ok(await capturePage({ ...args.chrome, browserUrl: lease.browserUrl }, args.url));
    } catch (cause) {
        return err({ stage: "capture", cause });
    } finally {
        const released = await withDeadline(
            startSeamCall(() => lease.release()),
            args.releaseMs,
        );
        if (released.isErr()) {
            const cause = faultCause(released.error, "the eyes lease did not release", args.releaseMs);
            args.logger.warn("the eyes lease did not release", args.logger.errorFields(cause));
        }
    }
}

/** The IANA media type of the screenshot. `page.screenshot` gives PNG bytes. */
const SCREENSHOT_MEDIA_TYPE = "image/png";

/** The line that the agent reads when the composition gives no browser. */
const NO_BROWSER_DETAIL = "the composition gives no browser, thus this session cannot look at its page";

/**
 * Make the eyes tool over the session-state gateway, the workspace-root seam, and the eyes of the composition.
 *
 * The tool reads the thread id from the scope of the call, and it resolves the page path under the workspace
 * root. Thus one factory serves every thread. The tool holds no per-session value.
 */
export function createExaminePageTool(deps: ExaminePageToolDeps): Tool<ExaminePageInput, ExaminePageResult> {
    const logger = (deps.logger ?? createNoopLogger()).named("examine-page");
    // The eyes of the composition are fixed here, thus one look reads one resolved transport and never the
    // precedence again.
    const transport = resolveEyes(deps);
    const acquireMs = deps.deadlines?.acquireMs ?? ACQUIRE_DEADLINE_MS;
    const releaseMs = deps.deadlines?.releaseMs ?? RELEASE_DEADLINE_MS;

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
            // page. The arm stamps no seen hash, because no eyes saw the page. It also narrows the transport
            // for the look below, thus the acquire needs no assertion.
            if (transport.kind === "none") {
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

            const relativePagePath = join(reportSessionDir(threadId), "index.html");
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

            // The scope of the acquire carries the analysis and the root that this call resolved. Thus a
            // realization that starts a browser mounts the same tree, and it holds no second resolver.
            const looked = await runLook({
                transport,
                chrome: deps.chrome,
                scope: { analysisId, workspaceRoot: root },
                url: pathToFileURL(pagePath).href,
                acquireMs,
                releaseMs,
                logger,
            });
            if (looked.isErr()) {
                const { stage, cause } = looked.error;
                logger.warn(LOOK_FAULT_MESSAGE[stage], { threadId, analysisId, ...defaultErrorFields(cause) });
                return ok({ outcome: "capture-failed", detail: cause instanceof Error ? cause.message : String(cause) });
            }
            const captured: PageCapture = looked.value;

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
