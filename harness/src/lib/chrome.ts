/**
 * Headless Chrome connection — process-lifetime singleton connected to the
 * Chrome sidecar reachable at `CHROME_BROWSER_URL`. Used by the iterate-report
 * preview-snapshot tool for visual validation.
 *
 * Connection is lazy and reconnect-on-disconnect; pages are gated through a
 * semaphore so the sidecar isn't overwhelmed by concurrent reports.
 */

import puppeteer from "puppeteer-core";
import type { Browser, BrowserContext, Page } from "puppeteer-core";

export interface ChromeConfig {
    readonly browserUrl?: string;
    readonly maxPages?: number;
}

let browser: Browser | undefined;
let connecting: Promise<Browser> | undefined;

let semaphore: Semaphore | undefined;

interface Semaphore {
    acquire(): Promise<() => void>;
}

function createSemaphore(max: number): Semaphore {
    let active = 0;
    const queue: Array<() => void> = [];
    const release = () => {
        active--;
        const next = queue.shift();
        if (next) next();
    };
    return {
        acquire(): Promise<() => void> {
            return new Promise((resolve) => {
                const grant = () => {
                    active++;
                    resolve(release);
                };
                if (active < max) grant();
                else queue.push(grant);
            });
        },
    };
}

function getSemaphore(maxPages?: number): Semaphore {
    if (!semaphore) {
        const max = maxPages && maxPages > 0 ? maxPages : 4;
        semaphore = createSemaphore(max);
    }
    return semaphore;
}

export async function getBrowser(browserUrl?: string): Promise<Browser> {
    if (browser && browser.connected) return browser;
    if (connecting) return connecting;

    const browserURL = browserUrl;
    if (!browserURL) {
        throw new Error("CHROME_BROWSER_URL is not set — Cortex requires the chrome sidecar to be reachable");
    }

    console.log(`[chrome] connecting to browser at ${browserURL}`);
    connecting = puppeteer
        .connect({ browserURL })
        .then((b) => {
            browser = b;
            b.on("disconnected", () => {
                console.log("[chrome] browser disconnected; will reconnect on next request");
                if (browser === b) browser = undefined;
            });
            console.log(`[chrome] connected (wsEndpoint=${b.wsEndpoint()})`);
            return b;
        })
        .catch((err) => {
            console.error("[chrome] failed to connect to browser:", err);
            throw err;
        })
        .finally(() => {
            connecting = undefined;
        });

    return connecting;
}

export async function withPage<T>(cfg: ChromeConfig, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    const release = await getSemaphore(cfg.maxPages).acquire();
    let context: BrowserContext | undefined;
    try {
        const b = await getBrowser(cfg.browserUrl);
        context = await b.createBrowserContext();
        const page = await context.newPage();
        return await fn(page, context);
    } finally {
        if (context) {
            try {
                await context.close();
            } catch (err) {
                console.error("[chrome] error closing browser context:", err);
            }
        }
        release();
    }
}
