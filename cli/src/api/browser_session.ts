/** How long a nonce works after the server makes it. */
export const NONCE_LIFETIME_MS = 60_000;

/** The response of `POST /api/v1/session/nonce`: a nonce that signs one browser in. */
export type SessionNonce = {
    /** 32 random bytes in hex. It works one time. */
    nonce: string;
    /** The time at which the nonce stops working, as an ISO 8601 string. */
    expiresAt: string;
};
