/**
 * The fetch stubs of the client suites: each suite stubs `globalThis.fetch` for one test, and the restore
 * hook of this module puts the real fetch back, and empties the recorded URLs, after each test.
 */

import { afterEach } from "bun:test";

import { requestUrlText } from "../../../lib/test/request-url.js";

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
export function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

const realFetch = globalThis.fetch;

/** The URLs that the latest recording stub answered, so a suite can name the requests that its client made. */
export const requestedUrls: string[] = [];

/**
 * Register the after-each restore of the real fetch. Each suite file calls this beside its imports, because
 * a hook that a shared module registers lands in the scope of the file that loads the module first.
 */
export function restoreFetchAfterEach(): void {
    afterEach(() => {
        globalThis.fetch = realFetch;
        requestedUrls.length = 0;
    });
}

/** Answer every request with the response that the callback builds from the request URL. */
export function stubFetch(response: (url: string) => Response): void {
    globalThis.fetch = fetchDouble((input) => Promise.resolve(response(requestUrlText(input))));
}

/** Answer every request with the given payload at status 200, and record each URL in `requestedUrls`. */
export function stubBodyFetch(body: unknown): void {
    requestedUrls.length = 0;
    globalThis.fetch = fetchDouble((input) => {
        requestedUrls.push(requestUrlText(input));
        return Promise.resolve(json(body));
    });
}

/** One JSON response of the given status. */
export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
