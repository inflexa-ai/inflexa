import { createHash, randomBytes } from "node:crypto";

import type { MakeSessionPagePublisher } from "@inflexa-ai/harness";
import { okAsync } from "neverthrow";

/** The most grants that the store keeps. */
export const PAGE_GRANT_LIMIT = 256;

/** The life of a grant, in ms. It is the life of a token of the managed content server. */
export const PAGE_GRANT_LIFETIME_MS = 900_000;

/** A grant that the store made, and the time at which it stops working, in ms since the epoch. */
export type MintedPageGrant = {
    readonly token: string;
    readonly expiresAtMs: number;
};

type Grant = {
    readonly analysisId: string;
    readonly threadId: string;
    readonly expiresAtMs: number;
};

/** The page grants of one server. It lives in memory, thus a restart ends each grant. */
export type PageGrantStore = {
    /** Make a grant for one report session, and give its token. */
    mint(analysisId: string, threadId: string): MintedPageGrant;
    /**
     * The whole seconds, rounded down, that a live grant of this session still lives. `null` when the token is
     * unknown, expired, or made for a different analysis or thread.
     */
    remainingSeconds(token: string, analysisId: string, threadId: string): number | null;
};

function digest(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

/**
 * A store that keeps the SHA-256 digest of each token, never the token, as the store of the browser sign-in does
 * (`browser_session.ts`). The expiry of a grant is exclusive: a grant that the store made {@link PAGE_GRANT_LIFETIME_MS}
 * ago no longer passes.
 *
 * A `Map` keeps its insertion order, so the first key is the oldest grant. Before a mint counts the grants, the
 * expired grants go. At {@link PAGE_GRANT_LIMIT} grants, the oldest grant goes, thus a grant can end before its
 * life is over.
 */
export function createPageGrantStore(now: () => number = Date.now): PageGrantStore {
    const grants = new Map<string, Grant>();

    return {
        mint(analysisId, threadId) {
            const at = now();
            for (const [key, grant] of grants) if (grant.expiresAtMs <= at) grants.delete(key);
            while (grants.size >= PAGE_GRANT_LIMIT) {
                const oldest = grants.keys().next();
                if (oldest.done) break;
                grants.delete(oldest.value);
            }
            const token = randomBytes(32).toString("hex");
            const expiresAtMs = at + PAGE_GRANT_LIFETIME_MS;
            grants.set(digest(token), { analysisId, threadId, expiresAtMs });
            return { token, expiresAtMs };
        },
        remainingSeconds(token, analysisId, threadId) {
            const grant = grants.get(digest(token));
            if (grant === undefined || grant.analysisId !== analysisId || grant.threadId !== threadId) return null;
            const remainingMs = grant.expiresAtMs - now();
            return remainingMs > 0 ? Math.floor(remainingMs / 1000) : null;
        },
    };
}

/**
 * The publisher factory that the server binds on the runtime. One process mints and checks the token, thus the
 * mint never fails. It ignores `auth`: one server serves one OS user, and the grant is the whole authorization of
 * the page route. `baseUrl` is the address of the server, because the store does not know its port.
 */
export function createSessionPagePublisherFactory(store: PageGrantStore, baseUrl: string): MakeSessionPagePublisher {
    return ({ analysisId }) => ({
        mintSessionPageAccess: (threadId) => {
            const { token, expiresAtMs } = store.mint(analysisId, threadId);
            return okAsync({ baseUrl, token, expiresAt: new Date(expiresAtMs).toISOString() });
        },
    });
}
