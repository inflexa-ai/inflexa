/**
 * Unit tests for the keyed connection cache.
 *
 * The cache keeps no state that a caller can read, thus the tests drive it through the connector seam. A
 * connector that makes a fake browser proves the keys, the eviction, and the gate with no sidecar at all.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { Browser } from "puppeteer-core";

import { getBrowser, setBrowserConnector, withPage } from "./chrome.js";

/** A browser that no process backs, plus the control that fires the disconnect event of that browser. */
interface FakeBrowser {
    readonly browser: Browser;
    emitDisconnected(): void;
}

function makeFakeBrowser(id: string): FakeBrowser {
    const listeners: Array<() => void> = [];
    const fake = {
        connected: true,
        on(event: string, listener: () => void) {
            if (event === "disconnected") listeners.push(listener);
        },
        wsEndpoint: () => `ws://${id}`,
        createBrowserContext: async () => ({
            newPage: async () => ({}),
            close: async () => {},
        }),
    };
    return {
        // The cache reads the connected flag, it registers the disconnect listener, it logs the socket
        // endpoint, and it opens one context for each page. The fake carries those four members, thus no call
        // of the cache reaches the gap between the fake and the class of puppeteer.
        browser: fake as unknown as Browser,
        emitDisconnected() {
            for (const listener of listeners) listener();
        },
    };
}

/** One turn of the macrotask queue. It drains the connect chain and the page setup of a pending call. */
function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

let restoreConnector: (() => void) | undefined;

afterEach(() => {
    restoreConnector?.();
    restoreConnector = undefined;
});

describe("the connection cache", () => {
    it("holds one connection for each endpoint", async () => {
        const calls: string[] = [];
        restoreConnector = setBrowserConnector(async (browserUrl) => {
            calls.push(browserUrl);
            return makeFakeBrowser(browserUrl).browser;
        });

        const one = await getBrowser("http://one.test:9222");
        const two = await getBrowser("http://two.test:9222");

        expect(calls).toEqual(["http://one.test:9222", "http://two.test:9222"]);
        expect(two).not.toBe(one);
        // Each endpoint answers with its own connection, thus the first endpoint never serves the second.
        expect(await getBrowser("http://one.test:9222")).toBe(one);
        expect(await getBrowser("http://two.test:9222")).toBe(two);
        expect(calls).toHaveLength(2);
    });

    it("reuses the connection of an endpoint that it reached already", async () => {
        let connects = 0;
        restoreConnector = setBrowserConnector(async (browserUrl) => {
            connects++;
            return makeFakeBrowser(browserUrl).browser;
        });

        const first = await getBrowser("http://warm.test:9222");
        const second = await getBrowser("http://warm.test:9222");

        expect(second).toBe(first);
        expect(connects).toBe(1);
    });

    it("evicts the entry of the endpoint that disconnected, and it keeps the other endpoint", async () => {
        const calls: string[] = [];
        const fakes: FakeBrowser[] = [];
        restoreConnector = setBrowserConnector(async (browserUrl) => {
            calls.push(browserUrl);
            const fake = makeFakeBrowser(`${browserUrl}/${calls.length}`);
            fakes.push(fake);
            return fake.browser;
        });

        const dead = await getBrowser("http://dead.test:9222");
        const live = await getBrowser("http://live.test:9222");
        // The connected flag of the fake stays true. Thus a second connect can come from the eviction alone,
        // and the test pins the eviction to the event. A real browser drops the flag, and the two signals
        // then agree.
        fakes[0].emitDisconnected();

        expect(await getBrowser("http://dead.test:9222")).not.toBe(dead);
        expect(await getBrowser("http://live.test:9222")).toBe(live);
        expect(calls).toEqual(["http://dead.test:9222", "http://live.test:9222", "http://dead.test:9222"]);
    });

    it("evicts the entry of a connect that failed, and it keeps a healthy endpoint", async () => {
        const calls: string[] = [];
        let refuse = true;
        restoreConnector = setBrowserConnector(async (browserUrl) => {
            calls.push(browserUrl);
            if (browserUrl === "http://broken.test:9222" && refuse) throw new Error("connect refused");
            return makeFakeBrowser(browserUrl).browser;
        });

        const healthy = await getBrowser("http://healthy.test:9222");
        await expect(withPage({ browserUrl: "http://broken.test:9222", maxPages: 1 }, async () => "unreachable")).rejects.toThrow("connect refused");
        refuse = false;

        // The failed entry is gone, thus the cap of the next caller makes the gate. A kept entry would hold
        // the gate of one page, and the second page below would wait for the first.
        const started: string[] = [];
        let finishFirst: (() => void) | undefined;
        const firstRuns = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const held = withPage({ browserUrl: "http://broken.test:9222", maxPages: 2 }, async () => {
            started.push("page-1");
            await firstRuns;
            return "page-1";
        });
        await tick();
        const other = withPage({ browserUrl: "http://broken.test:9222", maxPages: 2 }, async () => {
            started.push("page-2");
            return "page-2";
        });
        await tick();
        expect(started).toEqual(["page-1", "page-2"]);
        finishFirst?.();
        expect(await Promise.all([held, other])).toEqual(["page-1", "page-2"]);

        // The healthy endpoint kept its connection through the failure of its sibling, thus one eviction
        // reaches one entry.
        expect(await getBrowser("http://healthy.test:9222")).toBe(healthy);
        expect(calls).toEqual(["http://healthy.test:9222", "http://broken.test:9222", "http://broken.test:9222"]);
    });

    it("makes one connection for two calls against a cold endpoint", async () => {
        let connects = 0;
        let admit: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            admit = resolve;
        });
        restoreConnector = setBrowserConnector(async (browserUrl) => {
            connects++;
            await gate;
            return makeFakeBrowser(browserUrl).browser;
        });

        const first = getBrowser("http://cold.test:9222");
        const second = getBrowser("http://cold.test:9222");
        admit?.();
        const [one, two] = await Promise.all([first, second]);

        expect(connects).toBe(1);
        expect(two).toBe(one);
    });

    it("gates the pages of one endpoint, and it leaves a second endpoint free", async () => {
        restoreConnector = setBrowserConnector(async (browserUrl) => makeFakeBrowser(browserUrl).browser);
        const started: string[] = [];
        let finishFirst: (() => void) | undefined;
        const firstRuns = new Promise<void>((resolve) => {
            finishFirst = resolve;
        });
        const busy = { browserUrl: "http://busy.test:9222", maxPages: 1 };
        const idle = { browserUrl: "http://idle.test:9222", maxPages: 1 };

        const held = withPage(busy, async () => {
            started.push("busy-1");
            await firstRuns;
            return "busy-1";
        });
        await tick();
        const queued = withPage(busy, async () => {
            started.push("busy-2");
            return "busy-2";
        });
        const other = withPage(idle, async () => {
            started.push("idle-1");
            return "idle-1";
        });
        await tick();

        // The gate of the busy endpoint holds the second page of that endpoint. The idle endpoint has its own
        // gate, thus its page runs at the same time.
        expect(started).toEqual(["busy-1", "idle-1"]);

        finishFirst?.();
        expect(await Promise.all([held, queued, other])).toEqual(["busy-1", "busy-2", "idle-1"]);
        expect(started).toEqual(["busy-1", "idle-1", "busy-2"]);
    });

    it("refuses a config that names no endpoint", async () => {
        await expect(getBrowser(undefined)).rejects.toThrow("CHROME_BROWSER_URL");
        await expect(withPage({}, async () => "unreachable")).rejects.toThrow("CHROME_BROWSER_URL");
    });
});
