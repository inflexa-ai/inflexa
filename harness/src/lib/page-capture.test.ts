/**
 * Unit tests for the settle, the frame, the slicing, and the block of the capture.
 *
 * The connector seam of the chrome module hands the capture a page that no browser backs. Thus the order of
 * the steps and the arguments of each setter are observable with no sidecar at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Browser, MediaFeature, ScreenshotOptions, Viewport } from "puppeteer-core";

import { setBrowserConnector } from "./chrome.js";
import { capturePage } from "./page-capture.js";

/**
 * The steps that the capture drove, in order, the arguments that it gave to each of the three setters, and
 * the arguments of each block measure.
 */
interface Recorder {
    readonly steps: string[];
    readonly features: MediaFeature[][];
    readonly viewports: Viewport[];
    readonly shots: ScreenshotOptions[];
    readonly blockMeasures: unknown[][];
}

/** A recorder with each list empty, for one test. */
function makeRecorder(): Recorder {
    return { steps: [], features: [], viewports: [], shots: [], blockMeasures: [] };
}

/**
 * How the page answers the height measure and each screenshot call.
 *
 * `scrollHeight` is what the measure gives; absent, the measure gives no number and the page reads as short.
 * `blockArea` is what the block measure gives; absent, the page holds no mark of the block. A refusal names
 * the cause that a call raises. Absent, the call gives its picture. Each arm carries a different picture,
 * thus a test reads which call the result came from.
 */
interface ShotPlan {
    readonly scrollHeight?: number;
    readonly blockArea?: { x: number; width: number; fromY: number; toY: number };
    readonly failFullPage?: Error;
    readonly failViewport?: Error;
    readonly failTile?: Error;
}

/** The picture of the full-page call, and the picture of the viewport call. */
const FULL_PAGE_SHOT = "c2hvdA==";
const VIEWPORT_SHOT = "dmlld3BvcnQ=";

function makeFakeBrowser(recorder: Recorder, plan: ShotPlan = {}): Browser {
    const page = {
        on: () => {},
        setViewport: async (viewport: Viewport) => {
            recorder.steps.push("viewport");
            recorder.viewports.push(viewport);
        },
        emulateMediaFeatures: async (features: MediaFeature[]) => {
            recorder.steps.push("emulate");
            recorder.features.push(features);
        },
        goto: async () => {
            recorder.steps.push("goto");
        },
        // Each evaluation of the capture is a named function, thus the fake reads the name, and each
        // evaluation gets its own step name and answer.
        evaluate: async (body: { name: string }, ...args: unknown[]) => {
            if (body.name === "measureScrollHeight") {
                recorder.steps.push("measure");
                return plan.scrollHeight;
            }
            if (body.name === "measureBlock") {
                recorder.steps.push("measure-block");
                recorder.blockMeasures.push(args);
                return plan.blockArea ?? null;
            }
            recorder.steps.push("evaluate");
            return undefined;
        },
        screenshot: async (options: ScreenshotOptions) => {
            recorder.steps.push("screenshot");
            recorder.shots.push(options);
            if (options.clip !== undefined) {
                if (plan.failTile !== undefined) throw plan.failTile;
                return `TILE-${options.clip.y}`;
            }
            const refusal = options.fullPage === true ? plan.failFullPage : plan.failViewport;
            if (refusal !== undefined) throw refusal;
            return options.fullPage === true ? FULL_PAGE_SHOT : VIEWPORT_SHOT;
        },
    };
    const fake = {
        connected: true,
        on: () => {},
        wsEndpoint: () => "ws://capture.test",
        createBrowserContext: async () => ({
            newPage: async () => page,
            close: async () => {},
        }),
    };
    // The capture reads seven members of a page, and the connection cache reads four members of a browser.
    // The fake carries those members, thus no call of the capture reaches the gap between the fake and the
    // class of puppeteer.
    return fake as unknown as Browser;
}

let restoreConnector: (() => void) | undefined;

afterEach(() => {
    restoreConnector?.();
    restoreConnector = undefined;
});

describe("the settled capture", () => {
    it("sizes the window and emulates the reduced-motion preference before the navigation", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder));

        const capture = await capturePage({ browserUrl: "http://capture.test:9222" }, "http://page.test/report");

        // The size and the emulation both precede the navigation. Thus the layout resolves at the width of a
        // reader, and the page reveals its sections with each transition already collapsed.
        expect(recorder.steps).toEqual(["viewport", "emulate", "goto", "evaluate", "measure", "screenshot"]);
        expect(recorder.features).toEqual([[{ name: "prefers-reduced-motion", value: "reduce" }]]);
        expect(capture.screenshots).toEqual([{ base64: FULL_PAGE_SHOT }]);
        // The full-page call passed, thus the one picture holds the whole document.
        expect(capture.coverage).toEqual({ kind: "full" });
    });
});

describe("the framed capture", () => {
    it("gives the whole document at a window that clears each breakpoint of the design", async () => {
        const recorder = makeRecorder();
        // The connection cache holds one browser for each endpoint, thus this test names its own endpoint.
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder));

        await capturePage({ browserUrl: "http://capture-frame.test:9222" }, "http://page.test/report");

        // A narrow window collapses each multi-column band, and a window-sized picture hides each section
        // below the fold. Thus the two values together make the look checklist answerable. The half scale
        // keeps the layout and gives a picture of a quarter of the area.
        expect(recorder.viewports).toEqual([{ width: 1440, height: 900, deviceScaleFactor: 0.5 }]);
        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }]);
    });
});

describe("the tiled capture", () => {
    it("keeps the one full-page shot for a page at the single-shot bound", async () => {
        const recorder = makeRecorder();
        // A page at the bound reaches the model whole in one shot.
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { scrollHeight: 4000 }));

        const capture = await capturePage({ browserUrl: "http://capture-bound.test:9222" }, "http://page.test/report");

        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }]);
        expect(capture.coverage).toEqual({ kind: "full" });
        expect(capture.screenshots).toEqual([{ base64: FULL_PAGE_SHOT }]);
    });

    it("slices a tall page into consecutive tiles in document order", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { scrollHeight: 10000 }));

        const capture = await capturePage({ browserUrl: "http://capture-tall.test:9222" }, "http://page.test/report");

        // Each slice clips the slice height at the reader width, and the last slice ends at the document.
        expect(recorder.shots).toEqual([
            { encoding: "base64", clip: { x: 0, y: 0, width: 1440, height: 4000 } },
            { encoding: "base64", clip: { x: 0, y: 4000, width: 1440, height: 4000 } },
            { encoding: "base64", clip: { x: 0, y: 8000, width: 1440, height: 2000 } },
        ]);
        expect(capture.screenshots).toEqual([
            { base64: "TILE-0", range: { fromY: 0, toY: 4000 } },
            { base64: "TILE-4000", range: { fromY: 4000, toY: 8000 } },
            { base64: "TILE-8000", range: { fromY: 8000, toY: 10000 } },
        ]);
        // Every pixel is captured, and the coverage says so.
        expect(capture.coverage).toEqual({ kind: "tiled", capturedPx: 10000, totalPx: 10000 });
    });

    it("covers a long report of 16,000 pixels whole", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { scrollHeight: 16000 }));

        const capture = await capturePage({ browserUrl: "http://capture-long.test:9222" }, "http://page.test/report");

        expect(capture.screenshots).toHaveLength(4);
        expect(capture.coverage).toEqual({ kind: "tiled", capturedPx: 16000, totalPx: 16000 });
    });

    it("truncates at the tile budget and reports the captured and the total pixels", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { scrollHeight: 30000 }));

        const capture = await capturePage({ browserUrl: "http://capture-budget.test:9222" }, "http://page.test/report");

        // Five slices is the budget. The pictures end at the budget, and the coverage carries the honest
        // account: the captured pixels against the total, thus no reader mistakes the look for a whole one.
        expect(capture.screenshots).toHaveLength(5);
        expect(capture.screenshots[4]!.range).toEqual({ fromY: 16000, toY: 20000 });
        expect(capture.coverage).toEqual({ kind: "tiled", capturedPx: 20000, totalPx: 30000 });
    });

    it("retries at the window when a tile bitmap fails, and names the viewport coverage", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () =>
            makeFakeBrowser(recorder, { scrollHeight: 5000, failTile: new Error("the compositor refused the bitmap") }),
        );

        const capture = await capturePage({ browserUrl: "http://capture-tile-fail.test:9222" }, "http://page.test/report");

        // The retry drops the clip, and it runs on the page that already navigated. Thus one refused slice
        // costs one more screenshot call and no second load.
        expect(recorder.shots).toEqual([{ encoding: "base64", clip: { x: 0, y: 0, width: 1440, height: 4000 } }, { encoding: "base64" }]);
        expect(capture.screenshots).toEqual([{ base64: VIEWPORT_SHOT }]);
        expect(capture.coverage).toEqual({ kind: "viewport" });
    });
});

describe("the degraded capture", () => {
    it("retries at the window when the full-page bitmap fails, and names the viewport coverage", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { failFullPage: new Error("the compositor refused the bitmap") }));

        const capture = await capturePage({ browserUrl: "http://capture-degrade.test:9222" }, "http://page.test/report");

        // The retry drops the full-page flag, and it runs on the page that already navigated. Thus one
        // oversized page costs one more screenshot call and no second load.
        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }, { encoding: "base64" }]);
        expect(recorder.steps.filter((step) => step === "goto")).toEqual(["goto"]);
        // The picture came from the retry, and the coverage names what it holds.
        expect(capture.screenshots).toEqual([{ base64: VIEWPORT_SHOT }]);
        expect(capture.coverage).toEqual({ kind: "viewport" });
    });

    it("propagates the fault when the window bitmap also fails", async () => {
        const recorder = makeRecorder();
        const refusedFullPage = new Error("the compositor refused the bitmap");
        restoreConnector = setBrowserConnector(async () =>
            makeFakeBrowser(recorder, { failFullPage: refusedFullPage, failViewport: new Error("the browser is broken") }),
        );

        const capture = capturePage({ browserUrl: "http://capture-broken.test:9222" }, "http://page.test/report");

        // A window bitmap that also fails names a broken browser, thus the capture keeps its throw protocol.
        await expect(capture).rejects.toThrow("the browser is broken");
        // The report of a dead look names the second refusal, thus the first one rides on it as the cause.
        const thrown = await capture.catch((cause: unknown) => cause);
        expect((thrown as Error).cause).toBe(refusedFullPage);
        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }, { encoding: "base64" }]);
    });
});

describe("the block capture", () => {
    it("clips the measured box of the block, and names the block coverage", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () =>
            makeFakeBrowser(recorder, { scrollHeight: 16000, blockArea: { x: 300, width: 900, fromY: 5200, toY: 5700 } }),
        );

        const capture = await capturePage({ browserUrl: "http://capture-block.test:9222" }, "http://page.test/report", { blockId: "sec-results" });

        // The measure reads the mark of the renderer and the margin, and the whole page is never measured.
        expect(recorder.blockMeasures).toEqual([["data-block", "sec-results", 16]]);
        expect(recorder.steps).not.toContain("measure");
        expect(recorder.shots).toEqual([{ encoding: "base64", clip: { x: 300, y: 5200, width: 900, height: 500 } }]);
        expect(capture.screenshots).toEqual([{ base64: "TILE-5200", range: { fromY: 5200, toY: 5700 } }]);
        expect(capture.coverage).toEqual({ kind: "block", capturedPx: 500, totalPx: 500 });
    });

    it("slices a tall block, and cuts it at the budget", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () =>
            makeFakeBrowser(recorder, { scrollHeight: 40000, blockArea: { x: 0, width: 1440, fromY: 1000, toY: 26000 } }),
        );

        const capture = await capturePage({ browserUrl: "http://capture-block-tall.test:9222" }, "http://page.test/report", { blockId: "s1" });

        expect(capture.screenshots).toHaveLength(5);
        expect(capture.screenshots[0]!.range).toEqual({ fromY: 1000, toY: 5000 });
        expect(capture.screenshots[4]!.range).toEqual({ fromY: 17000, toY: 21000 });
        expect(capture.coverage).toEqual({ kind: "block", capturedPx: 20000, totalPx: 25000 });
    });

    it("takes no picture when the page holds no mark of the block", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder, { scrollHeight: 5000 }));

        const capture = await capturePage({ browserUrl: "http://capture-no-block.test:9222" }, "http://page.test/report", { blockId: "gone" });

        expect(recorder.shots).toEqual([]);
        expect(capture.screenshots).toEqual([]);
        expect(capture.coverage).toEqual({ kind: "no-block" });
    });

    it("propagates a refused slice of a block, because the window does not show the block", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(async () =>
            makeFakeBrowser(recorder, {
                blockArea: { x: 0, width: 1440, fromY: 3000, toY: 3400 },
                failTile: new Error("the compositor refused the bitmap"),
            }),
        );

        const capture = capturePage({ browserUrl: "http://capture-block-fail.test:9222" }, "http://page.test/report", { blockId: "b1" });

        await expect(capture).rejects.toThrow("the compositor refused the bitmap");
        expect(recorder.shots).toEqual([{ encoding: "base64", clip: { x: 0, y: 3000, width: 1440, height: 400 } }]);
    });
});
