import { createHash } from "node:crypto";

import { makeLocalAuth } from "@inflexa-ai/harness";
import { describe, expect, spyOn, test } from "bun:test";

import { createPageGrantStore, createSessionPagePublisherFactory, PAGE_GRANT_LIFETIME_MS, PAGE_GRANT_LIMIT } from "./report_page_grants.ts";

/** A store on a clock that a test moves. */
function storeWithClock(): { store: ReturnType<typeof createPageGrantStore>; advance: (ms: number) => void } {
    let at = 1_000_000;
    return { store: createPageGrantStore(() => at), advance: (ms) => void (at += ms) };
}

describe("the page grant store", () => {
    test("a token is 32 random bytes in hex, and each mint gives a new one", () => {
        const { store } = storeWithClock();
        const first = store.mint("a1", "t1");
        expect(first.token).toMatch(/^[0-9a-f]{64}$/);
        expect(first.expiresAtMs).toBe(1_000_000 + PAGE_GRANT_LIFETIME_MS);
        expect(store.mint("a1", "t1").token).not.toBe(first.token);
    });

    test("a grant names one session", () => {
        const { store } = storeWithClock();
        const { token } = store.mint("a1", "t1");
        expect(store.remainingSeconds(token, "a1", "t1")).not.toBeNull();
        expect(store.remainingSeconds(token, "a1", "t2")).toBeNull();
        expect(store.remainingSeconds(token, "a2", "t1")).toBeNull();
    });

    test("an unknown token and an empty token do not pass", () => {
        const { store } = storeWithClock();
        store.mint("a1", "t1");
        expect(store.remainingSeconds("f".repeat(64), "a1", "t1")).toBeNull();
        expect(store.remainingSeconds("", "a1", "t1")).toBeNull();
    });

    test("the remaining life counts down in whole seconds, rounded down", () => {
        const { store, advance } = storeWithClock();
        const { token } = store.mint("a1", "t1");
        expect(store.remainingSeconds(token, "a1", "t1")).toBe(900);
        advance(1);
        expect(store.remainingSeconds(token, "a1", "t1")).toBe(899);
        advance(PAGE_GRANT_LIFETIME_MS - 1_000);
        expect(store.remainingSeconds(token, "a1", "t1")).toBe(0);
    });

    test("a grant expires 900 s after its mint", () => {
        const { store, advance } = storeWithClock();
        const { token } = store.mint("a1", "t1");
        advance(PAGE_GRANT_LIFETIME_MS - 1);
        expect(store.remainingSeconds(token, "a1", "t1")).not.toBeNull();
        advance(1);
        expect(store.remainingSeconds(token, "a1", "t1")).toBeNull();
    });

    test("the store holds the digest of the token, and never the token", () => {
        const { store } = storeWithClock();
        const set = spyOn(Map.prototype, "set");
        let token: string;
        let keys: unknown[];
        let stored: string[];
        try {
            token = store.mint("a1", "t1").token;
            keys = set.mock.calls.map((call) => call[0]);
            stored = set.mock.calls.map((call) => JSON.stringify(call[1]));
        } finally {
            set.mockRestore();
        }
        expect(keys).toContain(createHash("sha256").update(token).digest("hex"));
        expect(keys).not.toContain(token);
        expect(stored.some((value) => value.includes(token))).toBe(false);
    });

    test("the oldest grant goes at the limit, and the new grant passes", () => {
        const { store } = storeWithClock();
        const grants = Array.from({ length: PAGE_GRANT_LIMIT }, (_, i) => store.mint("a1", `t${i}`));
        expect(store.remainingSeconds(grants[0]!.token, "a1", "t0")).not.toBeNull();
        const extra = store.mint("a1", "extra");
        expect(store.remainingSeconds(grants[0]!.token, "a1", "t0")).toBeNull();
        expect(store.remainingSeconds(grants[1]!.token, "a1", "t1")).not.toBeNull();
        expect(store.remainingSeconds(extra.token, "a1", "extra")).not.toBeNull();
    });

    test("a mint removes the expired grants before it counts, thus a live grant stays at the limit", () => {
        const { store, advance } = storeWithClock();
        const old = Array.from({ length: PAGE_GRANT_LIMIT - 1 }, (_, i) => store.mint("a1", `old${i}`));
        advance(PAGE_GRANT_LIFETIME_MS / 2);
        const live = store.mint("a1", "live");
        advance(PAGE_GRANT_LIFETIME_MS / 2);
        const fresh = store.mint("a1", "fresh");
        expect(store.remainingSeconds(old[0]!.token, "a1", "old0")).toBeNull();
        expect(store.remainingSeconds(live.token, "a1", "live")).not.toBeNull();
        expect(store.remainingSeconds(fresh.token, "a1", "fresh")).not.toBeNull();
    });
});

describe("the session page publisher factory", () => {
    const AUTH = makeLocalAuth();

    test("the mint gives the base URL, a token that passes for the analysis and thread, and an ISO expiry", async () => {
        const { store } = storeWithClock();
        const publisher = createSessionPagePublisherFactory(store, "http://127.0.0.1:8436")({ analysisId: "a1", auth: AUTH });
        const grant = (await publisher.mintSessionPageAccess("t1"))._unsafeUnwrap();
        expect(grant.baseUrl).toBe("http://127.0.0.1:8436");
        expect(grant.expiresAt).toBe(new Date(1_000_000 + PAGE_GRANT_LIFETIME_MS).toISOString());
        expect(store.remainingSeconds(grant.token, "a1", "t1")).toBe(900);
    });

    test("the token fails for a different thread and for a different analysis", async () => {
        const { store } = storeWithClock();
        const publisher = createSessionPagePublisherFactory(store, "http://127.0.0.1:8436")({ analysisId: "a1", auth: AUTH });
        const grant = (await publisher.mintSessionPageAccess("t1"))._unsafeUnwrap();
        expect(store.remainingSeconds(grant.token, "a1", "t2")).toBeNull();
        expect(store.remainingSeconds(grant.token, "a2", "t1")).toBeNull();
    });
});
