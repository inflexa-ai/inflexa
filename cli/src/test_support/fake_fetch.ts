/**
 * Give `fake` the type `typeof fetch`, for an assignment to `globalThis.fetch`. Bun types `fetch` with a
 * `preconnect` member, so the function that a test writes is not assignable as it is. The member is
 * borrowed from the current `fetch`, which keeps the replacement structurally complete with no cast.
 * The caller saves the real `fetch` before the assignment and restores it after the test.
 */
export function fakeFetch(fake: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign(fake, { preconnect: globalThis.fetch.preconnect });
}
