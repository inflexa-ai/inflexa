/**
 * Test-only `fetch` stub. Not a `*.test.ts` file, so the test runner ignores it;
 * imported by the tool unit tests.
 */

import { requestUrlText } from "../../lib/test/request-url.js";

/** One request that the stub received. */
export type SentRequest = { readonly url: string; readonly method: string; readonly body: string | undefined };

/** The answer to one request: a string body goes as it is, and any other body goes as JSON. */
export type StubAnswer = { readonly status: number; readonly body: unknown };

const realFetch = globalThis.fetch;

/** A `fetch` test double: the callable plus the `preconnect` member that `typeof fetch` carries. */
function fetchDouble(run: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(run, { preconnect: fetch.preconnect });
}

/**
 * Replace `globalThis.fetch` with a double that answers each request from `answer`. The returned array records each
 * request, in call order. Call `restoreFetch` after the test.
 */
export function stubFetch(answer: (url: URL) => StubAnswer): SentRequest[] {
    const requests: SentRequest[] = [];
    globalThis.fetch = fetchDouble((input, init) => {
        const url = requestUrlText(input);
        requests.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
        const { status, body } = answer(new URL(url));
        const text = typeof body === "string" ? body : JSON.stringify(body);
        return Promise.resolve(new Response(text, { status, headers: { "content-type": "application/json" } }));
    });
    return requests;
}

/** Put the real `fetch` back. */
export function restoreFetch(): void {
    globalThis.fetch = realFetch;
}
