/**
 * HMAC signing of the sandbox exec protocol (see the harness-sandbox-exec spec).
 *
 * Both directions use one construction: `X-Sandbox-Signature =
 * hex(HMAC-SHA256(secret, "${execId}:${timestamp}:${sha256Hex(body)}"))` plus
 * a `X-Sandbox-Timestamp` header. The host signs each request it sends to
 * sandbox-server, and sandbox-server signs each poll response at request time.
 * The secret is per sandbox, and it lives only in the cached `createSandbox`
 * step output.
 *
 * A bad or stale signature on a response is a hard cancel of the exec — under
 * NetworkPolicy isolation a forged response implies a bug or a breach, neither
 * of which should keep a 3-hour sandbox burning.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyExecMessageInput {
    execId: string;
    /** The exact bytes that sandbox-server signed. */
    body: Buffer | string;
    /** `X-Sandbox-Signature` value (lowercase hex). */
    signature: string | null;
    /** `X-Sandbox-Timestamp` value (unix seconds). */
    timestamp: number | null;
    /** Per-sandbox secret from the cached `createSandbox` step output. */
    secret: string;
    /** Current unix-second wall-clock — injectable for tests. */
    nowSec: number;
    /** Symmetric freshness window in seconds. */
    freshnessSec: number;
}

export type VerifyResult = { valid: true } | { valid: false; reason: "bad-signature" | "stale-timestamp" | "missing" };

/**
 * Decode the per-sandbox secret. sandbox-server accepts both raw UTF-8 and
 * `base64:` prefixed values; this mirrors the same convention, thus the host
 * and the Go side interpret the secret identically.
 */
function decodeSecret(secret: string): Buffer {
    if (secret.startsWith("base64:")) {
        return Buffer.from(secret.slice("base64:".length), "base64");
    }
    return Buffer.from(secret, "utf8");
}

function sha256Hex(input: Buffer | string): string {
    return createHash("sha256").update(input).digest("hex");
}

/**
 * Recompute the HMAC and compare in constant time, then check the
 * timestamp falls within a symmetric `freshnessSec` window of `nowSec`.
 *
 * Order: `missing` (one of signature/timestamp is null) is reported
 * separately from `bad-signature` so the caller can log it precisely.
 * Freshness is checked AFTER signature, so a stale-but-valid signature
 * is distinguishable from a forgery.
 */
export function verifyExecMessage(input: VerifyExecMessageInput): VerifyResult {
    if (input.signature === null || input.timestamp === null) {
        return { valid: false, reason: "missing" };
    }

    const secretBytes = decodeSecret(input.secret);
    const message = `${input.execId}:${input.timestamp}:${sha256Hex(input.body)}`;
    const expected = createHmac("sha256", secretBytes).update(message).digest("hex");

    const provided = input.signature;
    if (provided.length !== expected.length) {
        return { valid: false, reason: "bad-signature" };
    }
    const matches = timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"));
    if (!matches) {
        return { valid: false, reason: "bad-signature" };
    }

    if (Math.abs(input.nowSec - input.timestamp) > input.freshnessSec) {
        return { valid: false, reason: "stale-timestamp" };
    }
    return { valid: true };
}

/** Sign `body` for `execId` under the per-sandbox secret. */
export function signExecMessage({ execId, body, timestamp, secret }: { execId: string; body: Buffer | string; timestamp: number; secret: string }): string {
    const secretBytes = decodeSecret(secret);
    const message = `${execId}:${timestamp}:${sha256Hex(body)}`;
    return createHmac("sha256", secretBytes).update(message).digest("hex");
}
