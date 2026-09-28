/**
 * The one page capture over the Chrome sidecar.
 *
 * A capture navigates to a page URL, collects the console errors and the failed requests, waits for the
 * readiness signal of the page, and gives back base64 screenshots. The eyes tool of a report session reads
 * this module.
 *
 * The layout resolves at the CSS width of a reader, and the picture renders at half the device scale. A
 * picture costs tokens in proportion to its area, thus the half scale lets one look hold a whole report.
 *
 * A short page captures as one full-page shot. A tall page captures as consecutive vertical slices, because
 * the model reads a picture whole only up to a limit on the long edge, and a taller picture downscales or
 * refuses the request. The slice budget bounds what one look costs, and a page past the budget truncates
 * with the captured and the total pixels on the coverage, thus the truncation is never silent.
 *
 * A capture can also take one block alone. The renderer marks each block with its id, and the capture clips
 * the union box of the marked elements with a margin. A page that holds no such mark gives no picture.
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
import { BLOCK_ID_ATTRIBUTE } from "../report-render/views/block-mark.js";

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
 *
 * `block` is the box of one block and its margin; `capturedPx < totalPx` says that the slice budget cut it.
 * `no-block` means that no element of the page carries the mark of the block, thus no picture exists.
 */
export type CaptureCoverage =
    | { readonly kind: "full" }
    | { readonly kind: "tiled"; readonly capturedPx: number; readonly totalPx: number }
    | { readonly kind: "viewport" }
    | { readonly kind: "block"; readonly capturedPx: number; readonly totalPx: number }
    | { readonly kind: "no-block" };

/** The pictures and the faults of one page capture. */
export interface PageCapture {
    /**
     * The pictures in document order: one shot under `full` and `viewport`, the slices under `tiled` and
     * `block`, and none under `no-block`.
     */
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
export type CapturePage = (url: string, options?: CaptureOptions) => Promise<PageCapture>;

/** The extra settle steps and the target of one capture. A call site that needs none passes nothing. */
export interface CaptureOptions {
    /** A CSS selector to wait for after the readiness signal. The wait is best-effort. */
    readonly waitForSelector?: string;
    /** An extra settle time in milliseconds after the readiness signal, for a late paint. */
    readonly waitMs?: number;
    /** The id of the one block to capture. Absent, the capture takes the whole document. */
    readonly blockId?: string;
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
 * The device scale of one capture. The layout keeps the CSS width of a reader, and the picture holds half
 * the pixels on each side. A picture costs about one token for each 750 pixels of its area.
 */
const DEVICE_SCALE_FACTOR = 0.5;

/**
 * The height of one slice and the bound of a single-shot page, in CSS pixels. At the half scale a slice is
 * 720 by 2000 pixels, under the long edge of 2576 pixels that the model reads with no downscale.
 */
const TILE_HEIGHT_PX = 4_000;

/**
 * The most slices of one capture: 20,000 CSS pixels, about 9,600 tokens, thus a report of 16,000 pixels
 * fits whole. A taller page truncates, and the coverage carries the captured and the total pixels.
 */
const MAX_TILES = 5;

/** The margin around the box of one block, in CSS pixels. Content that overflows its box stays in the picture. */
const BLOCK_MARGIN_PX = 16;

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

/** A document area of one capture, in CSS pixels: the columns from `x`, and the rows from `fromY` to `toY`. */
interface CaptureArea {
    readonly x: number;
    readonly width: number;
    readonly fromY: number;
    readonly toY: number;
}

/**
 * Capture the rows of one area as slices, in document order. Each slice clips {@link TILE_HEIGHT_PX} rows,
 * and the last slice ends at the area or at the budget, whichever comes first.
 */
async function captureSlices(page: Page, area: CaptureArea): Promise<{ screenshots: CapturedShot[]; capturedPx: number }> {
    const heightPx = area.toY - area.fromY;
    const tileCount = Math.min(Math.ceil(heightPx / TILE_HEIGHT_PX), MAX_TILES);
    const screenshots: CapturedShot[] = [];
    for (let index = 0; index < tileCount; index++) {
        const fromY = area.fromY + index * TILE_HEIGHT_PX;
        const toY = Math.min(fromY + TILE_HEIGHT_PX, area.toY);
        const clip = { x: area.x, y: fromY, width: area.width, height: toY - fromY };
        screenshots.push({ base64: toBase64(await page.screenshot({ encoding: "base64", clip })), range: { fromY, toY } });
    }
    return { screenshots, capturedPx: Math.min(tileCount * TILE_HEIGHT_PX, heightPx) };
}

/**
 * The body of the block measure, in the browser context: the union box of the marked elements, with the
 * margin, or `null`. The body compares each attribute value, thus an id never becomes part of a selector.
 */
function measureBlock(attribute: string, blockId: string, margin: number): CaptureArea | null {
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const node of Array.from(document.querySelectorAll(`[${attribute}]`))) {
        if (node.getAttribute(attribute) !== blockId) continue;
        const rect = node.getBoundingClientRect();
        left = Math.min(left, rect.left + window.scrollX);
        top = Math.min(top, rect.top + window.scrollY);
        right = Math.max(right, rect.right + window.scrollX);
        bottom = Math.max(bottom, rect.bottom + window.scrollY);
    }
    if (left === Number.POSITIVE_INFINITY) {
        return null;
    }
    const root = document.documentElement;
    const x = Math.max(0, Math.floor(left - margin));
    const fromY = Math.max(0, Math.floor(top - margin));
    const toX = Math.min(root.scrollWidth, Math.ceil(right + margin));
    const toY = Math.min(root.scrollHeight, Math.ceil(bottom + margin));
    // A block of no height still gives a strip, thus the picture shows the empty place of the block.
    return { x, width: Math.max(1, toX - x), fromY, toY: Math.max(fromY + 1, toY) };
}

/**
 * Take the pictures of one block. A refused bitmap propagates, because the window shows the top of the page
 * and not the block.
 */
async function captureBlock(page: Page, blockId: string): Promise<Shots> {
    const area = await page.evaluate(measureBlock, BLOCK_ID_ATTRIBUTE, blockId, BLOCK_MARGIN_PX);
    if (area === null) {
        return { screenshots: [], coverage: { kind: "no-block" } };
    }
    const sliced = await captureSlices(page, area);
    return { screenshots: sliced.screenshots, coverage: { kind: "block", capturedPx: sliced.capturedPx, totalPx: area.toY - area.fromY } };
}

/**
 * Take the pictures of one settled page.
 *
 * A page at the single-shot bound or under gives one full-page shot. A taller page gives consecutive slices,
 * because the model downscales or refuses one tall picture; the module comment carries the account.
 *
 * The compositor can refuse a bitmap of either shape while the bitmap of the window is fine. A degraded
 * picture beats a dead look, thus a refusal retries one time at the window. A second throw names a broken
 * browser and not a tall page, thus it propagates to the caller.
 */
async function captureShots(page: Page): Promise<Shots> {
    const totalPx = await measureTotalHeight(page);
    try {
        if (totalPx > TILE_HEIGHT_PX) {
            const sliced = await captureSlices(page, { x: 0, width: VIEWPORT_WIDTH, fromY: 0, toY: totalPx });
            return { screenshots: sliced.screenshots, coverage: { kind: "tiled", capturedPx: sliced.capturedPx, totalPx } };
        }
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
 * what the pictures hold. A capture that names a block holds that block alone.
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
        await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: DEVICE_SCALE_FACTOR });

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
        const shots = options.blockId === undefined ? await captureShots(page) : await captureBlock(page, options.blockId);
        return {
            screenshots: shots.screenshots,
            coverage: shots.coverage,
            consoleErrors,
            failedRequests,
        };
    });
}
