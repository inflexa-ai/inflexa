/**
 * The connection to a headless Chrome endpoint.
 *
 * Two callers name an endpoint. A composition names a standing sidecar at assembly, and a lease of the eyes
 * seam names a browser for one look. Thus the module holds one connection for each endpoint, and it holds no
 * connection for the process.
 *
 * A connection is lazy, and an endpoint connects again after a disconnect. Each endpoint also carries its own
 * page gate. The gate bounds the pages that run at the same time against that one sidecar.
 */

import puppeteer from "puppeteer-core";
import type { Browser, BrowserContext, Page } from "puppeteer-core";

import { createNoopLogger } from "./console-logger.js";
import type { Logger } from "./logger.js";

export interface ChromeConfig {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /**
     * The endpoint of the Chrome sidecar. The connection is out of process, thus the sidecar has its own
     * filesystem and its own network position. A `file://` URL resolves against the filesystem of the
     * sidecar and never against the filesystem of the harness host. A caller that navigates to a workspace
     * file must run a sidecar that mounts the same workspace tree at the same path.
     *
     * An absent value means that the composition gives no browser at all. A caller that needs a look must
     * report that condition, not attempt a connection.
     */
    readonly browserUrl?: string;
    readonly maxPages?: number;
}

/** Whether a value names an endpoint. An absent value and a blank value each name none. */
function namesEndpoint(browserUrl: string | undefined): browserUrl is string {
    return browserUrl !== undefined && browserUrl.trim().length > 0;
}

/**
 * Whether the config names a browser to connect to. A composition with no endpoint has no eyes, and a
 * caller reads that up front instead of failing once for each attempted connection.
 *
 * The predicate narrows the config. Thus a caller that reads the endpoint after the gate needs no type
 * assertion for a field that the gate proved.
 */
export function hasBrowserUrl(cfg: ChromeConfig): cfg is ChromeConfig & { readonly browserUrl: string } {
    return namesEndpoint(cfg.browserUrl);
}

/**
 * The endpoint of a connection, or the refusal of a config that names none.
 *
 * The refusal and {@link hasBrowserUrl} read the same rule. Thus the gate that a caller reads up front is the
 * gate that the connection applies.
 */
function requireBrowserUrl(browserUrl: string | undefined): string {
    if (namesEndpoint(browserUrl)) return browserUrl;
    throw new Error("CHROME_BROWSER_URL is not set — Cortex requires the chrome sidecar to be reachable");
}

/** The connect operation of one endpoint. */
export type BrowserConnector = (browserUrl: string) => Promise<Browser>;

const connectOverPuppeteer: BrowserConnector = (browserUrl) => puppeteer.connect({ browserURL: browserUrl });

let connector: BrowserConnector = connectOverPuppeteer;

/**
 * Replace the connect operation, and give back the restore of the previous one.
 *
 * The cache keeps no state that a caller can read, because a connection is the only product of the module.
 * Thus a real browser is the only other way to drive the cache, and a unit test of the keys needs this seam.
 *
 * Two facts make the seam safe. The module reads the binding at each connect, and no module under `src/`
 * calls the setter. Thus a deployment always runs the connect of puppeteer. The caller restores the previous
 * binding, thus a replacement never reaches a later file of the same test run.
 */
export function setBrowserConnector(next: BrowserConnector): () => void {
    const previous = connector;
    connector = next;
    return () => {
        connector = previous;
    };
}

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

/** The cap on the pages that run at the same time against one endpoint, when a config names none. */
const DEFAULT_MAX_PAGES = 4;

/**
 * The live state of one endpoint: the connection, the connect in flight, and the page gate. The three share
 * one lifetime, thus one entry holds them and one eviction drops them together.
 */
interface EndpointEntry {
    browser?: Browser;
    connecting?: Promise<Browser>;
    readonly semaphore: Semaphore;
}

/**
 * The entry of each endpoint that the process reached, keyed by the endpoint URL. A disconnect evicts an
 * entry, thus a browser that appears for one look leaves nothing behind.
 */
const endpoints = new Map<string, EndpointEntry>();

/**
 * The entry of one endpoint, made on the first call for that endpoint.
 *
 * The first caller fixes the cap of the gate. A later caller with a different cap reads the gate that is
 * already in place, because one endpoint answers to one gate.
 */
function entryFor(browserUrl: string, maxPages?: number): EndpointEntry {
    const existing = endpoints.get(browserUrl);
    if (existing) return existing;
    const max = maxPages && maxPages > 0 ? maxPages : DEFAULT_MAX_PAGES;
    const fresh: EndpointEntry = { semaphore: createSemaphore(max) };
    endpoints.set(browserUrl, fresh);
    return fresh;
}

export async function getBrowser(browserUrl?: string, injected?: Logger): Promise<Browser> {
    const logger = (injected ?? createNoopLogger()).named("chrome");
    const browserURL = requireBrowserUrl(browserUrl);
    const entry = entryFor(browserURL);
    if (entry.browser?.connected) return entry.browser;
    if (entry.connecting) return entry.connecting;

    logger.info("connecting to browser", { browserURL });
    entry.connecting = connector(browserURL)
        .then((b) => {
            entry.browser = b;
            b.on("disconnected", () => {
                logger.info("browser disconnected; will reconnect on next request");
                // A reconnect can hold the key again by the time that the dead browser reports. The two
                // guards keep the eviction on the entry of this browser alone.
                if (endpoints.get(browserURL) === entry && entry.browser === b) endpoints.delete(browserURL);
            });
            logger.info("connected", { wsEndpoint: b.wsEndpoint() });
            return b;
        })
        .catch((err) => {
            logger.error("failed to connect to browser", logger.errorFields(err));
            // A failed connect leaves nothing to reuse. The entry goes, thus a run of looks that each name a
            // new endpoint and each fail cannot grow the map. The two guards match the disconnect listener,
            // thus a reconnect that already took the key survives.
            //
            // A waiter that already holds a slot of the evicted gate keeps running, and a later caller makes
            // a fresh gate. Thus the page cap of this endpoint can be exceeded for a moment. That is
            // acceptable, because the connect just failed and no browser exists for either gate to bound.
            if (endpoints.get(browserURL) === entry && entry.browser === undefined) endpoints.delete(browserURL);
            throw err;
        })
        .finally(() => {
            entry.connecting = undefined;
        });

    return entry.connecting;
}

export async function withPage<T>(cfg: ChromeConfig, fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
    // The gate belongs to one endpoint, thus the endpoint must be known before the gate. A config that names
    // none refuses here, the same as the connection below refuses it.
    const browserURL = requireBrowserUrl(cfg.browserUrl);
    const release = await entryFor(browserURL, cfg.maxPages).semaphore.acquire();
    let context: BrowserContext | undefined;
    try {
        const b = await getBrowser(browserURL, cfg.logger);
        context = await b.createBrowserContext();
        const page = await context.newPage();
        return await fn(page, context);
    } finally {
        if (context) {
            try {
                await context.close();
            } catch (err) {
                const logger = (cfg.logger ?? createNoopLogger()).named("chrome");
                logger.error("error closing browser context", logger.errorFields(err));
            }
        }
        release();
    }
}
