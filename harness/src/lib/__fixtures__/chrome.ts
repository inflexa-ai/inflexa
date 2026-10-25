/**
 * Test doubles for the chrome connection seam.
 *
 * The fakes carry the members that the connection cache and the capture read, so no test reaches the gap
 * between a fake and the vendor surface behind the structural types of `chrome.ts`.
 */

import type { ConnectedBrowser, LookPage } from "../chrome.js";

/**
 * A page that no browser backs. The page function member runs no page body — the capture treats a refused
 * measure as a short page and a refused readiness wait as a page that captures as it stands, so the reject
 * lands in the catch that each caller already carries.
 */
export function fakeLookPage(overrides: Partial<LookPage> = {}): LookPage {
    return {
        on: () => {},
        setViewport: () => Promise.resolve(),
        emulateMediaFeatures: () => Promise.resolve(),
        goto: () => Promise.resolve(),
        waitForSelector: () => Promise.resolve(null),
        screenshot: () => Promise.resolve("ZmFrZS1wbmc="),
        evaluate: (): Promise<never> => Promise.reject(new Error("the fake page runs no page function")),
        ...overrides,
    };
}

/** A browser that no process backs, holding one page for each context that the look opens. */
export function fakeLookBrowser(pageOverrides: Partial<LookPage> = {}): ConnectedBrowser {
    return {
        connected: true,
        on: () => {},
        wsEndpoint: () => "ws://fake.test",
        createBrowserContext: () =>
            Promise.resolve({
                newPage: () => Promise.resolve(fakeLookPage(pageOverrides)),
                close: () => Promise.resolve(),
            }),
    };
}
