import { ok } from "neverthrow";

import type { ClientOpts } from "../client/api.ts";

/** One request that a {@link fakeClient} saw. `path` holds the query, and `body` is the parsed JSON body. */
export type FakeRequest = { method: string; path: string; body: unknown };

/** The answer of a {@link fakeClient} to one request: a status and a JSON body. */
export type FakeResponse = { status: number; body: unknown };

const BASE_URL = "http://server.test";

/**
 * {@link ClientOpts} for a TUI or client test with no server: `answer` gives the status and the JSON body of
 * each request, and `requests` records each one in order. A test of a client surface asserts on the requests
 * that it sends and on what it shows for a given answer; the routes have their own tests in `src/server/`.
 */
export function fakeClient(answer: (req: FakeRequest) => FakeResponse): { opts: ClientOpts; requests: FakeRequest[] } {
    const requests: FakeRequest[] = [];
    return {
        requests,
        opts: {
            discover: () => ok({ baseUrl: BASE_URL, token: "test-token" }),
            fetch: async (url, init) => {
                // `unknown`: the body is whatever JSON the client under test sent.
                const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
                const req: FakeRequest = { method: init.method ?? "GET", path: url.slice(BASE_URL.length), body };
                requests.push(req);
                const res = answer(req);
                return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
            },
        },
    };
}
