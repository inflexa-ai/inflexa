/**
 * Unit tests for the settle of the capture.
 *
 * The connector seam of the chrome module hands the capture a page that no browser backs. Thus the order of
 * the emulation and the navigation is observable with no sidecar at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Browser, MediaFeature } from "puppeteer-core";

import { setBrowserConnector } from "./chrome.js";
import { capturePage } from "./page-capture.js";

/** The steps that the capture drove, in order, and the media features that it emulated. */
interface Recorder {
    readonly steps: string[];
    readonly features: MediaFeature[][];
}

function makeFakeBrowser(recorder: Recorder): Browser {
    const page = {
        on: () => {},
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
        screenshot: async () => {
            recorder.steps.push("screenshot");
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
    // The capture reads five members of a page, and the connection cache reads four members of a browser. The
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
    it("emulates the reduced-motion preference before the navigation", async () => {
        const recorder: Recorder = { steps: [], features: [] };
        restoreConnector = setBrowserConnector(async () => makeFakeBrowser(recorder));

        const capture = await capturePage({ browserUrl: "http://capture.test:9222" }, "http://page.test/report");

        // The emulation precedes the navigation, thus the page reveals its sections with each transition
        // already collapsed. A later emulation would reach a page that ran its transitions already.
        expect(recorder.steps).toEqual(["emulate", "goto", "evaluate", "screenshot"]);
        expect(recorder.features).toEqual([[{ name: "prefers-reduced-motion", value: "reduce" }]]);
        expect(capture.screenshotBase64).toBe("c2hvdA==");
    });
});
