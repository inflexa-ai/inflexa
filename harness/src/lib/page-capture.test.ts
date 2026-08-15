/**
 * Unit tests for the settle and the frame of the capture.
 *
 * The connector seam of the chrome module hands the capture a page that no browser backs. Thus the order of
 * the steps and the arguments of each setter are observable with no sidecar at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Browser, MediaFeature, ScreenshotOptions, Viewport } from "puppeteer-core";

import { setBrowserConnector } from "./chrome.js";
import { capturePage } from "./page-capture.js";

/** The steps that the capture drove, in order, and the arguments that it gave to each of the three setters. */
interface Recorder {
    readonly steps: string[];
    readonly features: MediaFeature[][];
    readonly viewports: Viewport[];
    readonly shots: ScreenshotOptions[];
}

/** A recorder with each list empty, for one test. */
function makeRecorder(): Recorder {
    return { steps: [], features: [], viewports: [], shots: [] };
}

function makeFakeBrowser(recorder: Recorder): Browser {
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
        evaluate: async () => {
            recorder.steps.push("evaluate");
        },
        screenshot: async (options: ScreenshotOptions) => {
            recorder.steps.push("screenshot");
            recorder.shots.push(options);
            return "c2hvdA==";
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
    // The capture reads six members of a page, and the connection cache reads four members of a browser. The
    // fake carries those members, thus no call of the capture reaches the gap between the fake and the class
    // of puppeteer.
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
        expect(recorder.steps).toEqual(["viewport", "emulate", "goto", "evaluate", "screenshot"]);
        expect(recorder.features).toEqual([[{ name: "prefers-reduced-motion", value: "reduce" }]]);
        expect(capture.screenshotBase64).toBe("c2hvdA==");
    });
});

describe("the framed capture", () => {
    it("gives the whole document at a window that clears each breakpoint of the design", async () => {
        const recorder = makeRecorder();
        // The connection cache holds one browser for each endpoint, thus this test names its own endpoint.
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder));

        await capturePage({ browserUrl: "http://capture-frame.test:9222" }, "http://page.test/report");

        // A narrow window collapses each multi-column band, and a window-sized picture hides each section
        // below the fold. Thus the two values together make the look checklist answerable.
        expect(recorder.viewports).toEqual([{ width: 1440, height: 900 }]);
        expect(recorder.shots).toEqual([{ encoding: "base64", fullPage: true }]);
    });
});
