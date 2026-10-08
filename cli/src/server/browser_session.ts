import { createHash, randomBytes } from "node:crypto";

import { NONCE_LIFETIME_MS } from "../api/browser_session.ts";

/** The most nonces that are not used, and the most sessions, that the store keeps. */
export const BROWSER_SESSION_LIMIT = 32;

/** The path of the sign-in route. It is the one route under `/api/` that needs no credential. */
export const SIGN_IN_PATH = "/api/v1/session";

/** The 401 message of a sign-in or a cookie that the server does not know, for example after a restart. */
export const SIGN_IN_AGAIN_MESSAGE = "This browser is not signed in to this server. Run `inflexa gui` again.";

/**
 * The name of the session cookie of the server on `port`. Cookies ignore the port, so the name keeps the
 * production server and the dev server on one host apart. `undefined` is a request that no socket carried.
 */
export function sessionCookieName(port: number | undefined): string {
    return port === undefined ? "inflexa_session" : `inflexa_session_${port}`;
}

/** A nonce that the store made, and the time at which it stops working, in ms since the epoch. */
export type IssuedNonce = {
    readonly nonce: string;
    readonly expiresAtMs: number;
};

/** The nonces and the browser sessions of one server. It lives in memory, thus a restart ends each session. */
export type BrowserSessionStore = {
    issueNonce(): IssuedNonce;
    /** True, one time, for a nonce that the store made and that did not expire. */
    consumeNonce(nonce: string): boolean;
    /** Make a session, and give its secret. */
    openSession(): string;
    hasSession(secret: string): boolean;
};

function newSecret(): string {
    return randomBytes(32).toString("hex");
}

function digest(secret: string): string {
    return createHash("sha256").update(secret).digest("hex");
}

/**
 * A store that keeps the SHA-256 digest of each nonce and of each session secret, never the value. A lookup by
 * digest can show the digest through its timing, but not the secret, and a digest does not give back the
 * secret. Thus a lookup needs no constant-time compare.
 *
 * A `Map` keeps its insertion order, so the first key is the oldest entry. At the limit, the oldest entry of a
 * kind goes. A nonce lives {@link NONCE_LIFETIME_MS}, a session lives as long as the store.
 */
export function createBrowserSessionStore(now: () => number = Date.now): BrowserSessionStore {
    const nonces = new Map<string, number>();
    const sessions = new Set<string>();

    function dropOldest<K>(entries: Map<K, unknown> | Set<K>): void {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
    }

    return {
        issueNonce() {
            const at = now();
            for (const [key, expiresAtMs] of nonces) if (expiresAtMs <= at) nonces.delete(key);
            while (nonces.size >= BROWSER_SESSION_LIMIT) dropOldest(nonces);
            const nonce = newSecret();
            const expiresAtMs = at + NONCE_LIFETIME_MS;
            nonces.set(digest(nonce), expiresAtMs);
            return { nonce, expiresAtMs };
        },
        consumeNonce(nonce) {
            const key = digest(nonce);
            const expiresAtMs = nonces.get(key);
            if (expiresAtMs === undefined) return false;
            nonces.delete(key);
            return expiresAtMs > now();
        },
        openSession() {
            while (sessions.size >= BROWSER_SESSION_LIMIT) dropOldest(sessions);
            const secret = newSecret();
            sessions.add(digest(secret));
            return secret;
        },
        hasSession(secret) {
            return sessions.has(digest(secret));
        },
    };
}
