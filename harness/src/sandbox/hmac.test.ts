/**
 * HMAC verification — the contract the workflow-body recv loop trusts to
 * accept / hard-cancel a callback.
 */

import { describe, expect, test } from "bun:test";
import { signCallback, verifyCallback } from "./hmac.js";

const SECRET = "base64:" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const EXEC_ID = "wf-1:step-a:fn-0";
const NOW = 1_700_000_000;
const FRESHNESS = 300;

describe("verifyCallback", () => {
    test("matching signature within freshness window passes", () => {
        const body = JSON.stringify({ kind: "file-tree", added: ["/x.txt"] });
        const sig = signCallback({
            execId: EXEC_ID,
            body,
            timestamp: NOW,
            secret: SECRET,
        });

        const result = verifyCallback({
            execId: EXEC_ID,
            body,
            signature: sig,
            timestamp: NOW,
            secret: SECRET,
            nowSec: NOW + 10,
            freshnessSec: FRESHNESS,
        });

        expect(result).toEqual({ valid: true });
    });

    test("mismatched signature fails as bad-signature", () => {
        const body = "{}";
        const sig = signCallback({
            execId: EXEC_ID,
            body,
            timestamp: NOW,
            secret: SECRET,
        });
        // Flip one nibble.
        const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");

        const result = verifyCallback({
            execId: EXEC_ID,
            body,
            signature: tampered,
            timestamp: NOW,
            secret: SECRET,
            nowSec: NOW,
            freshnessSec: FRESHNESS,
        });

        expect(result).toEqual({ valid: false, reason: "bad-signature" });
    });

    test("body tampering fails as bad-signature even with correct signature", () => {
        const body = JSON.stringify({ kind: "phase", phase: "running" });
        const sig = signCallback({
            execId: EXEC_ID,
            body,
            timestamp: NOW,
            secret: SECRET,
        });

        const result = verifyCallback({
            execId: EXEC_ID,
            body: JSON.stringify({ kind: "phase", phase: "completed" }),
            signature: sig,
            timestamp: NOW,
            secret: SECRET,
            nowSec: NOW,
            freshnessSec: FRESHNESS,
        });

        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason).toBe("bad-signature");
    });

    test("timestamp outside freshness window fails as stale-timestamp", () => {
        const body = "{}";
        const stale = NOW - (FRESHNESS + 10);
        const sig = signCallback({
            execId: EXEC_ID,
            body,
            timestamp: stale,
            secret: SECRET,
        });

        const result = verifyCallback({
            execId: EXEC_ID,
            body,
            signature: sig,
            timestamp: stale,
            secret: SECRET,
            nowSec: NOW,
            freshnessSec: FRESHNESS,
        });

        expect(result).toEqual({ valid: false, reason: "stale-timestamp" });
    });

    test("missing signature or timestamp fails as missing", () => {
        const body = "{}";
        expect(
            verifyCallback({
                execId: EXEC_ID,
                body,
                signature: null,
                timestamp: NOW,
                secret: SECRET,
                nowSec: NOW,
                freshnessSec: FRESHNESS,
            }),
        ).toEqual({ valid: false, reason: "missing" });
        expect(
            verifyCallback({
                execId: EXEC_ID,
                body,
                signature: "x".repeat(64),
                timestamp: null,
                secret: SECRET,
                nowSec: NOW,
                freshnessSec: FRESHNESS,
            }),
        ).toEqual({ valid: false, reason: "missing" });
    });

    test("execId mixing fails verification (per-exec binding holds)", () => {
        const body = "{}";
        const sig = signCallback({
            execId: "wf-1:step-a:fn-0",
            body,
            timestamp: NOW,
            secret: SECRET,
        });

        const result = verifyCallback({
            execId: "wf-1:step-b:fn-0",
            body,
            signature: sig,
            timestamp: NOW,
            secret: SECRET,
            nowSec: NOW,
            freshnessSec: FRESHNESS,
        });
        expect(result.valid).toBe(false);
    });

    test("raw (non-base64) secret works the same way", () => {
        const raw = "plain-utf8-secret";
        const body = "{}";
        const sig = signCallback({
            execId: EXEC_ID,
            body,
            timestamp: NOW,
            secret: raw,
        });

        const result = verifyCallback({
            execId: EXEC_ID,
            body,
            signature: sig,
            timestamp: NOW,
            secret: raw,
            nowSec: NOW,
            freshnessSec: FRESHNESS,
        });
        expect(result).toEqual({ valid: true });
    });
});
