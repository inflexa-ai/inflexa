import { describe, expect, test } from "bun:test";

import { NONCE_LIFETIME_MS } from "../api/browser_session.ts";
import { BROWSER_SESSION_LIMIT, createBrowserSessionStore } from "./browser_session.ts";

/** A store on a clock that a test moves. */
function storeWithClock(): { store: ReturnType<typeof createBrowserSessionStore>; advance: (ms: number) => void } {
    let at = 1_000_000;
    return { store: createBrowserSessionStore(() => at), advance: (ms) => void (at += ms) };
}

describe("the nonces", () => {
    test("a nonce is 32 random bytes in hex, and it expires 60 s after the store makes it", () => {
        const { store } = storeWithClock();
        const first = store.issueNonce();
        expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(first.expiresAtMs).toBe(1_000_000 + NONCE_LIFETIME_MS);
        expect(store.issueNonce().nonce).not.toBe(first.nonce);
    });

    test("a nonce works one time", () => {
        const { store } = storeWithClock();
        const { nonce } = store.issueNonce();
        expect(store.consumeNonce(nonce)).toBe(true);
        expect(store.consumeNonce(nonce)).toBe(false);
    });

    test("an unknown nonce and an empty nonce do not work", () => {
        const { store } = storeWithClock();
        store.issueNonce();
        expect(store.consumeNonce("f".repeat(64))).toBe(false);
        expect(store.consumeNonce("")).toBe(false);
    });

    test("a nonce works at 59 s and does not work at 61 s", () => {
        const { store, advance } = storeWithClock();
        const early = store.issueNonce().nonce;
        const late = store.issueNonce().nonce;
        advance(59_000);
        expect(store.consumeNonce(early)).toBe(true);
        advance(2_000);
        expect(store.consumeNonce(late)).toBe(false);
    });

    test("the store keeps at most the limit of nonces, and the oldest goes first", () => {
        const { store } = storeWithClock();
        const issued = Array.from({ length: BROWSER_SESSION_LIMIT + 1 }, () => store.issueNonce().nonce);
        const [oldest = "", ...rest] = issued;
        expect(store.consumeNonce(oldest)).toBe(false);
        for (const nonce of rest) expect(store.consumeNonce(nonce)).toBe(true);
    });
});

describe("the sessions", () => {
    test("a session secret is 32 random bytes in hex, and the store knows it", () => {
        const { store } = storeWithClock();
        const secret = store.openSession();
        expect(secret).toMatch(/^[0-9a-f]{64}$/);
        expect(store.hasSession(secret)).toBe(true);
        expect(store.openSession()).not.toBe(secret);
    });

    test("an unknown secret and an empty secret name no session", () => {
        const { store } = storeWithClock();
        store.openSession();
        expect(store.hasSession("f".repeat(64))).toBe(false);
        expect(store.hasSession("")).toBe(false);
    });

    test("a session does not expire with time", () => {
        const { store, advance } = storeWithClock();
        const secret = store.openSession();
        advance(24 * 60 * 60 * 1000);
        expect(store.hasSession(secret)).toBe(true);
    });

    test("the store keeps at most the limit of sessions, and the oldest goes first", () => {
        const { store } = storeWithClock();
        const secrets = Array.from({ length: BROWSER_SESSION_LIMIT + 1 }, () => store.openSession());
        const [oldest = "", ...rest] = secrets;
        expect(store.hasSession(oldest)).toBe(false);
        for (const secret of rest) expect(store.hasSession(secret)).toBe(true);
    });

    test("a nonce is not a session secret", () => {
        const { store } = storeWithClock();
        const { nonce } = store.issueNonce();
        expect(store.hasSession(nonce)).toBe(false);
    });
});
