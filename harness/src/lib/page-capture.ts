/**
 * The one page capture over the Chrome sidecar.
 *
 * A capture navigates to a page URL, collects the console errors and the failed requests, waits for the
 * readiness signal of the page, and gives back a base64 screenshot. Two tools capture a report page: the
 * preview snapshot of the old report path and the eyes tool of a report session. Both read this module.
 *
 * The readiness contract is the reason for one shared body. The renderer emits the event name and the
 * sentinel name, and `report-render/page.ts` owns both constants together with the two budgets. This module
 * imports them, thus a rename or a retime reaches the waiter at compile time. A second copy of the wait
 * script would instead degrade every capture to the readiness timeout, and no type would break.
 *
 * The capture speaks the throw protocol, because the chrome connection does. A caller that needs a typed
 * outcome guards the call.
 */

import { withPage, type ChromeConfig } from "./chrome.js";
import { PAGE_NAV_TIMEOUT_MS, PAGE_READY_TIMEOUT_MS, THEME_READY_EVENT, THEME_READY_SENTINEL } from "../report-render/page.js";

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
 * browser, thus a tool orchestration runs with no chrome sidecar.
 */
export type CapturePage = (url: string) => Promise<PageCapture>;

/** The extra settle steps that one call site needs. A call site that needs neither passes nothing. */
export interface CaptureOptions {
    /** A CSS selector to wait for after the readiness signal. The wait is best-effort. */
    readonly waitForSelector?: string;
    /** An extra settle time in milliseconds after the readiness signal, for a late paint. */
    readonly waitMs?: number;
}

/** The budget of the optional selector wait. The wait is best-effort, thus a miss captures the page anyway. */
const SELECTOR_TIMEOUT_MS = 5_000;

/**
 * The body of the readiness wait, in the browser context. The sentinel arm resolves a page that dispatched
 * the event before this wait registered, thus a plain listener never blocks forever. The timer arm bounds a
 * page that never signals.
 *
 * The browser runs this body as source text. Thus the body reads no module binding, and each value that it
 * needs arrives as a parameter. The page evaluation sends a parameter as data, thus no value becomes code.
 */
function waitForThemeReady(sentinel: string, event: string, timeout: number): Promise<void> {
    return new Promise<void>((resolve) => {
        // The sentinel name arrives as a value, thus no declared property of the global object describes it.
        if ((window as unknown as Record<string, unknown>)[sentinel]) {
            resolve();
            return;
        }
        const timer = setTimeout(() => {
            resolve();
        }, timeout);
        document.addEventListener(
            event,
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/**
 * Capture one page: the screenshot, the console errors, and the failed requests.
 *
 * The readiness wait is best-effort. A page that never signals still captures at the readiness budget, thus
 * a broken page gives a picture that shows what broke.
 */
export function capturePage(chrome: ChromeConfig, url: string, options: CaptureOptions = {}): Promise<PageCapture> {
    return withPage(chrome, async (page) => {
        const consoleErrors: string[] = [];
        const failedRequests: FailedRequest[] = [];

        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
        page.on("requestfailed", (req) => {
            failedRequests.push({ url: req.url(), reason: req.failure()?.errorText ?? "unknown" });
        });

        await page.goto(url, { waitUntil: "networkidle2", timeout: PAGE_NAV_TIMEOUT_MS });

        // The two names and the budget ride as arguments, because the browser context has no module scope.
        await page.evaluate(waitForThemeReady, THEME_READY_SENTINEL, THEME_READY_EVENT, PAGE_READY_TIMEOUT_MS).catch(() => {
            /* the picture captures as it stands */
        });

        if (options.waitForSelector !== undefined) {
            await page.waitForSelector(options.waitForSelector, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => {
                /* the picture captures as it stands */
            });
        }
        if (options.waitMs !== undefined && options.waitMs > 0) {
            const settle = options.waitMs;
            await new Promise((resolve) => setTimeout(resolve, settle));
        }

        const screenshot = await page.screenshot({ encoding: "base64", fullPage: false });
        return {
            screenshotBase64: typeof screenshot === "string" ? screenshot : Buffer.from(screenshot).toString("base64"),
            consoleErrors,
            failedRequests,
        };
    });
}
