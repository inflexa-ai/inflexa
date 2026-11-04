/**
 * Give `fake` the type `typeof fetch`, for an assignment to `globalThis.fetch`. Bun types `fetch` with a
 * `preconnect` member, so the function that a test writes is not assignable as it is. The member is
 * borrowed from the current `fetch`, which keeps the replacement structurally complete with no cast.
 * The caller saves the real `fetch` before the assignment and restores it after the test.
 */
export function fakeFetch(fake: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(fake, { preconnect: globalThis.fetch.preconnect });
}

/**
 * A fetch double that answers each call with a new `Response` of `body` and `init`, so a body reads one
 * time for each call. A `Response` that its constructor refuses (a status out of range) comes back as a
 * rejection, as a rejecting `fetch` does.
 */
export function respondWith(body?: BodyInit | null, init?: ResponseInit): () => Promise<Response> {
    return () => Promise.try(() => new Response(body, init));
}

/** The URL text of the first argument of `fetch`, in each of its three forms: a string as itself, a `URL` as its `href`, and a `Request` as its `url`. */
export function fetchInputUrl(input: string | URL | Request): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    return input.url;
}
