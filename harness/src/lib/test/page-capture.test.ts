/**
 * Unit tests for the settle, the frame, the slicing, and the block of the capture.
 *
 * The connector seam of the chrome module hands the capture a page that no browser backs. Thus the order of
 * the steps and the arguments of each setter are observable with no sidecar at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Browser, BrowserContext, type EvaluateFunc, type MediaFeature, Page, type ScreenshotOptions, type Viewport } from "puppeteer-core";

import { must } from "./guards.js";
import { setBrowserConnector } from "../chrome.js";
import { capturePage } from "../page-capture.js";
import { isError } from "../thrown.js";

/**
 * The steps that the capture drove, in order, the arguments that it gave to each of the three setters, and
 * the arguments of each block measure.
 */
type Recorder = {
    readonly steps: string[];
    readonly features: MediaFeature[][];
    readonly viewports: Viewport[];
    readonly shots: ScreenshotOptions[];
    readonly blockMeasures: unknown[][];
};

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
type ShotPlan = {
    readonly scrollHeight?: number;
    readonly blockArea?: { x: number; width: number; fromY: number; toY: number };
    readonly failFullPage?: Error;
    readonly failViewport?: Error;
    readonly failTile?: Error;
};

/** The picture of the full-page call, and the picture of the viewport call. */
const FULL_PAGE_SHOT = "c2hvdA==";
const VIEWPORT_SHOT = "dmlld3BvcnQ=";

/** The loud answer of a member the capture never drives. */
function unstubbed(where: string): never {
    throw new Error(`${where}: the capture does not drive this member`);
}

/**
 * The page, the context, and the browser of one capture, as real puppeteer subclasses.
 *
 * The puppeteer classes carry an `EventEmitter` base that holds a `#private`
 * field, so no object literal types as one and a subclass instance is the only
 * cast-free double (the kit pattern of `src/lib/test/doubles.ts`). The page
 * answers the members the capture drives: each setter records its step and its
 * argument, each evaluation is dispatched by the name of the function the
 * capture sends, and each screenshot call records its options and answers the
 * plan. Every other member fails loudly.
 */
class RecordingPage extends Page {
    readonly #recorder: Recorder;
    readonly #plan: ShotPlan;
    constructor(recorder: Recorder, plan: ShotPlan) {
        super();
        this.#recorder = recorder;
        this.#plan = plan;
    }
    override setViewport(viewport: Viewport): Promise<void> {
        this.#recorder.steps.push("viewport");
        this.#recorder.viewports.push(viewport);
        return Promise.resolve();
    }
    override emulateMediaFeatures(features: MediaFeature[]): Promise<void> {
        this.#recorder.steps.push("emulate");
        this.#recorder.features.push(features);
        return Promise.resolve();
    }
    override goto(): Promise<null> {
        this.#recorder.steps.push("goto");
        return Promise.resolve(null);
    }
    override evaluate<Params extends unknown[], Func extends EvaluateFunc<Params>>(
        pageFunction: Func | string,
        ...args: Params
    ): Promise<Awaited<ReturnType<Func>>>;
    override evaluate(...args: unknown[]): Promise<unknown> {
        const body = args.at(0);
        if (typeof body === "function" && body.name === "measureScrollHeight") {
            this.#recorder.steps.push("measure");
            return Promise.resolve(this.#plan.scrollHeight);
        }
        if (typeof body === "function" && body.name === "measureBlock") {
            this.#recorder.steps.push("measure-block");
            this.#recorder.blockMeasures.push(args.slice(1));
            return Promise.resolve(this.#plan.blockArea ?? null);
        }
        this.#recorder.steps.push("evaluate");
        return Promise.resolve(undefined);
    }
    override waitForSelector(): Promise<never> {
        return unstubbed("RecordingPage.waitForSelector");
    }
    override screenshot(options?: Readonly<ScreenshotOptions> & { encoding: "base64" }): Promise<string>;
    override screenshot(options?: Readonly<ScreenshotOptions>): Promise<Uint8Array>;
    override screenshot(options?: Readonly<ScreenshotOptions>): Promise<string | Uint8Array> {
        const shot = must(options, "screenshot options");
        this.#recorder.steps.push("screenshot");
        this.#recorder.shots.push(shot);
        if (shot.clip !== undefined) {
            if (this.#plan.failTile !== undefined) return Promise.reject(this.#plan.failTile);
            return Promise.resolve(`TILE-${shot.clip.y}`);
        }
        const refusal = shot.fullPage === true ? this.#plan.failFullPage : this.#plan.failViewport;
        if (refusal !== undefined) return Promise.reject(refusal);
        return Promise.resolve(shot.fullPage === true ? FULL_PAGE_SHOT : VIEWPORT_SHOT);
    }
    override close(): Promise<void> {
        return Promise.resolve();
    }

    override isServiceWorkerBypassed(): boolean {
        return unstubbed("RecordingPage.isServiceWorkerBypassed");
    }
    override isDragInterceptionEnabled(): boolean {
        return unstubbed("RecordingPage.isDragInterceptionEnabled");
    }
    override isJavaScriptEnabled(): boolean {
        return unstubbed("RecordingPage.isJavaScriptEnabled");
    }
    override waitForFileChooser(): Promise<never> {
        return unstubbed("RecordingPage.waitForFileChooser");
    }
    override setGeolocation(): Promise<void> {
        return unstubbed("RecordingPage.setGeolocation");
    }
    override target(): never {
        return unstubbed("RecordingPage.target");
    }
    override browser(): never {
        return unstubbed("RecordingPage.browser");
    }
    override browserContext(): never {
        return unstubbed("RecordingPage.browserContext");
    }
    override mainFrame(): never {
        return unstubbed("RecordingPage.mainFrame");
    }
    override createCDPSession(): Promise<never> {
        return unstubbed("RecordingPage.createCDPSession");
    }
    override get keyboard(): never {
        return unstubbed("RecordingPage.keyboard");
    }
    override get touchscreen(): never {
        return unstubbed("RecordingPage.touchscreen");
    }
    override get coverage(): never {
        return unstubbed("RecordingPage.coverage");
    }
    override get tracing(): never {
        return unstubbed("RecordingPage.tracing");
    }
    override get mouse(): never {
        return unstubbed("RecordingPage.mouse");
    }
    override frames(): never[] {
        return unstubbed("RecordingPage.frames");
    }
    override workers(): never[] {
        return unstubbed("RecordingPage.workers");
    }
    override setRequestInterception(): Promise<void> {
        return unstubbed("RecordingPage.setRequestInterception");
    }
    override setBypassServiceWorker(): Promise<void> {
        return unstubbed("RecordingPage.setBypassServiceWorker");
    }
    override setDragInterception(): Promise<void> {
        return unstubbed("RecordingPage.setDragInterception");
    }
    override setOfflineMode(): Promise<void> {
        return unstubbed("RecordingPage.setOfflineMode");
    }
    override emulateNetworkConditions(): Promise<void> {
        return unstubbed("RecordingPage.emulateNetworkConditions");
    }
    override setDefaultNavigationTimeout(): void {
        unstubbed("RecordingPage.setDefaultNavigationTimeout");
    }
    override setDefaultTimeout(): void {
        unstubbed("RecordingPage.setDefaultTimeout");
    }
    override getDefaultTimeout(): number {
        return unstubbed("RecordingPage.getDefaultTimeout");
    }
    override getDefaultNavigationTimeout(): number {
        return unstubbed("RecordingPage.getDefaultNavigationTimeout");
    }
    override queryObjects(): Promise<never> {
        return unstubbed("RecordingPage.queryObjects");
    }
    override cookies(): Promise<never[]> {
        return unstubbed("RecordingPage.cookies");
    }
    override deleteCookie(): Promise<void> {
        return unstubbed("RecordingPage.deleteCookie");
    }
    override setCookie(): Promise<void> {
        return unstubbed("RecordingPage.setCookie");
    }
    override exposeFunction(): Promise<void> {
        return unstubbed("RecordingPage.exposeFunction");
    }
    override removeExposedFunction(): Promise<void> {
        return unstubbed("RecordingPage.removeExposedFunction");
    }
    override authenticate(): Promise<void> {
        return unstubbed("RecordingPage.authenticate");
    }
    override setExtraHTTPHeaders(): Promise<void> {
        return unstubbed("RecordingPage.setExtraHTTPHeaders");
    }
    override setUserAgent(): Promise<void> {
        return unstubbed("RecordingPage.setUserAgent");
    }
    override metrics(): Promise<never> {
        return unstubbed("RecordingPage.metrics");
    }
    override reload(): Promise<null> {
        return unstubbed("RecordingPage.reload");
    }
    override goBack(): Promise<null> {
        return unstubbed("RecordingPage.goBack");
    }
    override goForward(): Promise<null> {
        return unstubbed("RecordingPage.goForward");
    }
    override bringToFront(): Promise<void> {
        return unstubbed("RecordingPage.bringToFront");
    }
    override setJavaScriptEnabled(): Promise<void> {
        return unstubbed("RecordingPage.setJavaScriptEnabled");
    }
    override setBypassCSP(): Promise<void> {
        return unstubbed("RecordingPage.setBypassCSP");
    }
    override emulateMediaType(): Promise<void> {
        return unstubbed("RecordingPage.emulateMediaType");
    }
    override emulateCPUThrottling(): Promise<void> {
        return unstubbed("RecordingPage.emulateCPUThrottling");
    }
    override emulateTimezone(): Promise<void> {
        return unstubbed("RecordingPage.emulateTimezone");
    }
    override emulateIdleState(): Promise<void> {
        return unstubbed("RecordingPage.emulateIdleState");
    }
    override emulateVisionDeficiency(): Promise<void> {
        return unstubbed("RecordingPage.emulateVisionDeficiency");
    }
    override viewport(): null {
        return unstubbed("RecordingPage.viewport");
    }
    override evaluateOnNewDocument(): Promise<never> {
        return unstubbed("RecordingPage.evaluateOnNewDocument");
    }
    override removeScriptToEvaluateOnNewDocument(): Promise<void> {
        return unstubbed("RecordingPage.removeScriptToEvaluateOnNewDocument");
    }
    override setCacheEnabled(): Promise<void> {
        return unstubbed("RecordingPage.setCacheEnabled");
    }
    override createPDFStream(): Promise<never> {
        return unstubbed("RecordingPage.createPDFStream");
    }
    override pdf(): Promise<Uint8Array> {
        return unstubbed("RecordingPage.pdf");
    }
    override isClosed(): boolean {
        return unstubbed("RecordingPage.isClosed");
    }
    override waitForDevicePrompt(): Promise<never> {
        return unstubbed("RecordingPage.waitForDevicePrompt");
    }
}

class RecordingContext extends BrowserContext {
    readonly #page: RecordingPage;
    constructor(recorder: Recorder, plan: ShotPlan) {
        super();
        this.#page = new RecordingPage(recorder, plan);
    }
    override newPage(): Promise<Page> {
        return Promise.resolve(this.#page);
    }
    override close(): Promise<void> {
        return Promise.resolve();
    }
    override targets(): never[] {
        return unstubbed("RecordingContext.targets");
    }
    override pages(): Promise<Page[]> {
        return unstubbed("RecordingContext.pages");
    }
    override overridePermissions(): Promise<void> {
        return unstubbed("RecordingContext.overridePermissions");
    }
    override clearPermissionOverrides(): Promise<void> {
        return unstubbed("RecordingContext.clearPermissionOverrides");
    }
    override browser(): never {
        return unstubbed("RecordingContext.browser");
    }
    override cookies(): Promise<never[]> {
        return unstubbed("RecordingContext.cookies");
    }
    override setCookie(): Promise<void> {
        return unstubbed("RecordingContext.setCookie");
    }
}

class RecordingBrowser extends Browser {
    readonly #context: RecordingContext;
    constructor(recorder: Recorder, plan: ShotPlan) {
        super();
        this.#context = new RecordingContext(recorder, plan);
    }
    override get connected(): boolean {
        return true;
    }
    override get debugInfo() {
        return { pendingProtocolErrors: [] };
    }
    // A browser reached over CDP holds no child process, so `null` is the honest answer.
    override process(): null {
        return null;
    }
    override createBrowserContext(): Promise<BrowserContext> {
        return Promise.resolve(this.#context);
    }
    override browserContexts(): BrowserContext[] {
        return [this.#context];
    }
    override defaultBrowserContext(): BrowserContext {
        return this.#context;
    }
    override wsEndpoint(): string {
        return "ws://capture.test";
    }
    override newPage(): Promise<Page> {
        return this.#context.newPage();
    }
    override version(): Promise<string> {
        return Promise.resolve("stub");
    }
    override userAgent(): Promise<string> {
        return Promise.resolve("stub");
    }
    override close(): Promise<void> {
        return Promise.resolve();
    }
    override disconnect(): Promise<void> {
        return Promise.resolve();
    }
    override targets(): never[] {
        return unstubbed("RecordingBrowser.targets");
    }
    override target(): never {
        return unstubbed("RecordingBrowser.target");
    }
}

function makeFakeBrowser(recorder: Recorder, plan: ShotPlan = {}): Browser {
    return new RecordingBrowser(recorder, plan);
}

let restoreConnector: (() => void) | undefined;

afterEach(() => {
    restoreConnector?.();
    restoreConnector = undefined;
});

describe("the settled capture", () => {
    it("sizes the window and emulates the reduced-motion preference before the navigation", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder)));

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
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder)));

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
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 4000 })));

        const capture = await capturePage({ browserUrl: "http://capture-bound.test:9222" }, "http://page.test/report");

        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }]);
        expect(capture.coverage).toEqual({ kind: "full" });
        expect(capture.screenshots).toEqual([{ base64: FULL_PAGE_SHOT }]);
    });

    it("slices a tall page into consecutive tiles in document order", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 10000 })));

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
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 16000 })));

        const capture = await capturePage({ browserUrl: "http://capture-long.test:9222" }, "http://page.test/report");

        expect(capture.screenshots).toHaveLength(4);
        expect(capture.coverage).toEqual({ kind: "tiled", capturedPx: 16000, totalPx: 16000 });
    });

    it("truncates at the tile budget and reports the captured and the total pixels", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 30000 })));

        const capture = await capturePage({ browserUrl: "http://capture-budget.test:9222" }, "http://page.test/report");

        // Five slices is the budget. The pictures end at the budget, and the coverage carries the honest
        // account: the captured pixels against the total, thus no reader mistakes the look for a whole one.
        expect(capture.screenshots).toHaveLength(5);
        expect(capture.screenshots[4].range).toEqual({ fromY: 16000, toY: 20000 });
        expect(capture.coverage).toEqual({ kind: "tiled", capturedPx: 20000, totalPx: 30000 });
    });

    it("retries at the window when a tile bitmap fails, and names the viewport coverage", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 5000, failTile: new Error("the compositor refused the bitmap") })),
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
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(makeFakeBrowser(recorder, { failFullPage: new Error("the compositor refused the bitmap") })),
        );

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
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(makeFakeBrowser(recorder, { failFullPage: refusedFullPage, failViewport: new Error("the browser is broken") })),
        );

        const capture = capturePage({ browserUrl: "http://capture-broken.test:9222" }, "http://page.test/report");

        // A window bitmap that also fails names a broken browser, thus the capture keeps its throw protocol.
        await expect(capture).rejects.toThrow("the browser is broken");
        // The report of a dead look names the second refusal, thus the first one rides on it as the cause.
        const thrown = await capture.catch((cause: unknown) => cause);
        const thrownError = isError(thrown) ? thrown : undefined;
        expect(thrownError?.cause).toBe(refusedFullPage);
        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }, { encoding: "base64" }]);
    });
});

describe("the block capture", () => {
    it("clips the measured box of the block, and names the block coverage", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 16000, blockArea: { x: 300, width: 900, fromY: 5200, toY: 5700 } })),
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
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 40000, blockArea: { x: 0, width: 1440, fromY: 1000, toY: 26000 } })),
        );

        const capture = await capturePage({ browserUrl: "http://capture-block-tall.test:9222" }, "http://page.test/report", { blockId: "s1" });

        expect(capture.screenshots).toHaveLength(5);
        expect(capture.screenshots[0].range).toEqual({ fromY: 1000, toY: 5000 });
        expect(capture.screenshots[4].range).toEqual({ fromY: 17000, toY: 21000 });
        expect(capture.coverage).toEqual({ kind: "block", capturedPx: 20000, totalPx: 25000 });
    });

    it("takes no picture when the page holds no mark of the block", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() => Promise.resolve(makeFakeBrowser(recorder, { scrollHeight: 5000 })));

        const capture = await capturePage({ browserUrl: "http://capture-no-block.test:9222" }, "http://page.test/report", { blockId: "gone" });

        expect(recorder.shots).toEqual([]);
        expect(capture.screenshots).toEqual([]);
        expect(capture.coverage).toEqual({ kind: "no-block" });
    });

    it("propagates a refused slice of a block, because the window does not show the block", async () => {
        const recorder = makeRecorder();
        restoreConnector = setBrowserConnector(() =>
            Promise.resolve(
                makeFakeBrowser(recorder, {
                    blockArea: { x: 0, width: 1440, fromY: 3000, toY: 3400 },
                    failTile: new Error("the compositor refused the bitmap"),
                }),
            ),
        );

        const capture = capturePage({ browserUrl: "http://capture-block-fail.test:9222" }, "http://page.test/report", { blockId: "b1" });

        await expect(capture).rejects.toThrow("the compositor refused the bitmap");
        expect(recorder.shots).toEqual([{ encoding: "base64", clip: { x: 0, y: 3000, width: 1440, height: 400 } }]);
    });
});
