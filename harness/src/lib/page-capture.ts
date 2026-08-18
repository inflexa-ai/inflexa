/**
 * The one page capture over the Chrome sidecar.
 *
 * A capture navigates to a page URL, collects the console errors and the failed requests, waits for the
 * readiness signal of the page, and gives back base64 screenshots. The eyes tool of a report session reads
 * this module.
 *
 * A short page captures as one full-page shot. A tall page captures as consecutive vertical slices, because
 * one tall picture dies twice on the provider path: a picture past the hard dimension cap rejects the whole
 * request, and a legal tall picture downscales to about 1568 pixels on the long side, which compresses the
 * text past legibility. A slice of about two window heights survives both. The slice budget bounds what one
 * look costs, and a page past the budget truncates with the captured and the total pixels on the coverage,
 * thus the truncation is never silent.
 *
 * The readiness contract is the reason for one shared body. The renderer emits the event name and the
 * sentinel name, and `report-render/page.ts` owns both constants together with the two budgets. This module
 * imports them, thus a rename or a retime reaches the waiter at compile time. A second copy of the wait
 * script would instead degrade every capture to the readiness timeout, and no type would break.
 *
 * The capture emulates the reduced-motion preference before the navigation. The design source collapses each
 * transition under that preference, and it starts each reveal in its visible state. Thus the picture shows
 * the final state, and no element appears mid-fade.
 *
 * The capture speaks the throw protocol, because the chrome connection does. A caller that needs a typed
 * outcome guards the call.
 */

import type { Page } from "puppeteer-core";

import { withPage, type ChromeConfig } from "./chrome.js";
import { PAGE_NAV_TIMEOUT_MS, PAGE_READY_TIMEOUT_MS, THEME_READY_EVENT, THEME_READY_SENTINEL } from "../report-render/page.js";

/** One request that the page could not load, with the reason that the browser gave. */
export interface FailedRequest {
    url: string;
    reason: string;
}

/** One picture of a capture: the base64 bytes, and the document rows that a slice holds. */
export interface CapturedShot {
    readonly base64: string;
    /** The vertical document range of a slice, in CSS pixels. Absent on a whole-document or window picture. */
    readonly range?: { readonly fromY: number; readonly toY: number };
}

/**
 * What the pictures hold together. `full` is one shot of the whole document. `tiled` is consecutive vertical
 * slices in document order; `capturedPx` is the height the slices cover and `totalPx` is the document height,
 * thus `capturedPx < totalPx` says that the slice budget ran out and the tail of the page is absent. `viewport`
 * appears when a screenshot threw and the retry at the window passed, thus the one picture shows the top
 * window alone and a section below the fold is absent from it.
 */
export type CaptureCoverage =
    | { readonly kind: "full" }
    | { readonly kind: "tiled"; readonly capturedPx: number; readonly totalPx: number }
    | { readonly kind: "viewport" };

/** The pictures and the faults of one page capture. */
export interface PageCapture {
    /** The pictures in document order: one shot under `full` and `viewport`, the slices under `tiled`. */
    screenshots: CapturedShot[];
    coverage: CaptureCoverage;
    consoleErrors: string[];
    failedRequests: FailedRequest[];
}

/**
 * The capture seam. It navigates to a page URL, and it gives back the screenshots and the faults. The seam
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
 * The window of one capture, in CSS pixels.
 *
 * The width clears each breakpoint of the design source. Thus a multi-column band lays out at the width that a
 * reader gets, and no band collapses to one column because the window was narrow.
 */
const VIEWPORT_WIDTH = 1440;
const VIEWPORT_HEIGHT = 900;

/**
 * The height of one capture slice, in CSS pixels, and the bound of a single-shot page.
 *
 * The provider downscales every picture to about 1568 pixels on the long side before the model reads it. Two
 * window heights survive that downscale with readable text, and a taller picture reaches the model compressed
 * past that. Thus a page at this height or under captures as one full-page shot, and a taller page captures
 * as slices of this height.
 */
const TILE_HEIGHT_PX = VIEWPORT_HEIGHT * 2;

/**
 * The most slices of one capture.
 *
 * Each slice is one picture on the tool result, and the budget bounds what one look costs the context. A page
 * taller than the budget covers truncates, and the coverage carries the captured and the total pixels, thus
 * the truncation is never silent.
 */
const MAX_TILES = 6;

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

/** The pictures of one capture pass: the shots in document order, and what they hold together. */
type Shots = Pick<PageCapture, "screenshots" | "coverage">;

/** The connection gives base64 text or raw bytes, and a caller of the capture reads base64 text alone. */
function toBase64(shot: string | Uint8Array): string {
    return typeof shot === "string" ? shot : Buffer.from(shot).toString("base64");
}

/** The body of the height measure, in the browser context. */
function measureScrollHeight(): number {
    return document.documentElement.scrollHeight;
}

/**
 * Measure the document height, in CSS pixels. A page that refuses the measure reads as a short one, thus the
 * capture takes the one full-page shot and the refusal costs no look.
 */
async function measureTotalHeight(page: Page): Promise<number> {
    const measured = await page.evaluate(measureScrollHeight).catch(() => undefined);
    return typeof measured === "number" && Number.isFinite(measured) ? measured : 0;
}

/**
 * Capture the slices of one tall page, in document order. Each slice clips {@link TILE_HEIGHT_PX} rows at the
 * reader width, and the last slice ends at the document height or at the budget, whichever comes first.
 */
async function captureTiles(page: Page, totalPx: number): Promise<Shots> {
    const tileCount = Math.min(Math.ceil(totalPx / TILE_HEIGHT_PX), MAX_TILES);
    const screenshots: CapturedShot[] = [];
    for (let index = 0; index < tileCount; index++) {
        const fromY = index * TILE_HEIGHT_PX;
        const toY = Math.min(fromY + TILE_HEIGHT_PX, totalPx);
        const clip = { x: 0, y: fromY, width: VIEWPORT_WIDTH, height: toY - fromY };
        screenshots.push({ base64: toBase64(await page.screenshot({ encoding: "base64", clip })), range: { fromY, toY } });
    }
    const capturedPx = Math.min(tileCount * TILE_HEIGHT_PX, totalPx);
    return { screenshots, coverage: { kind: "tiled", capturedPx, totalPx } };
}

/**
 * Take the pictures of one settled page.
 *
 * A page at the single-shot bound or under gives one full-page shot. A taller page gives consecutive slices,
 * because the provider path compresses or rejects one tall picture; the module comment carries the account.
 *
 * The compositor can refuse a bitmap of either shape while the bitmap of the window is fine. A degraded
 * picture beats a dead look, thus a refusal retries one time at the window. A second throw names a broken
 * browser and not a tall page, thus it propagates to the caller.
 */
async function captureShots(page: Page): Promise<Shots> {
    const totalPx = await measureTotalHeight(page);
    try {
        if (totalPx > TILE_HEIGHT_PX) return await captureTiles(page, totalPx);
        return { screenshots: [{ base64: toBase64(await page.screenshot({ encoding: "base64", fullPage: true })) }], coverage: { kind: "full" } };
    } catch (refused) {
        try {
            return { screenshots: [{ base64: toBase64(await page.screenshot({ encoding: "base64" })) }], coverage: { kind: "viewport" } };
        } catch (refusedViewport) {
            // The two refusals together are the account of a dead look, and the caller reports the second one
            // alone. Thus the first one rides as the cause, and no reader of that report loses half of it.
            if (refusedViewport instanceof Error && refusedViewport.cause === undefined) {
                refusedViewport.cause = refused;
            }
            throw refusedViewport;
        }
    }
}

/**
 * Capture one page: the screenshots, the console errors, and the failed requests.
 *
 * The pictures hold the document, and not the window alone. Thus a caller can judge a section that a reader
 * reaches by a scroll. A short page arrives as one full-page shot, and a tall page arrives as consecutive
 * slices in document order. A refused bitmap degrades to the window, and the coverage of the result names
 * what the pictures hold.
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

        // The size is set before the navigation, because a layout resolves at load time. The connection gives
        // a small default window, and that window collapses each multi-column band of the design.
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

        // The preference is active before the navigation, because the page reveals its sections as it loads.
        // A preference that arrives after the load reaches a page that already runs its transitions.
        await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);

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

        // The pictures must show the whole document at the layout that a reader gets. Thus a defect below the
        // fold is visible, and a question about content that never appeared has an answer.
        const shots = await captureShots(page);
        return {
            screenshots: shots.screenshots,
            coverage: shots.coverage,
            consoleErrors,
            failedRequests,
        };
    });
}
