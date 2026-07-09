import { describe, expect, it } from "bun:test";

import { classifyProviderError, isProviderError, toProviderError } from "./errors.js";

/** Build a synthetic API error carrying an HTTP status, SDK-shaped. */
function apiError(status: number): Error {
    return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("classifyProviderError", () => {
    it("classifies a billing gateway 402 as a non-retryable budget error", () => {
        expect(classifyProviderError(apiError(402))).toEqual({
            kind: "budget",
            retryable: false,
        });
    });

    it("classifies a billing gateway 403 as a non-retryable tenant-blocked error", () => {
        expect(classifyProviderError(apiError(403))).toEqual({
            kind: "tenant-blocked",
            retryable: false,
        });
    });

    it("classifies 429 as a retryable provider error", () => {
        expect(classifyProviderError(apiError(429))).toEqual({
            kind: "provider",
            retryable: true,
        });
    });

    it("classifies 503 as a retryable provider error", () => {
        expect(classifyProviderError(apiError(503))).toEqual({
            kind: "provider",
            retryable: true,
        });
    });

    it("classifies a connection-refused error as a retryable provider error", () => {
        const connErr = new TypeError("fetch failed", {
            cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8181"), {
                code: "ECONNREFUSED",
            }),
        });
        expect(classifyProviderError(connErr)).toEqual({
            kind: "provider",
            retryable: true,
        });
    });

    it("classifies 400 as a non-retryable provider error", () => {
        expect(classifyProviderError(apiError(400))).toEqual({
            kind: "provider",
            retryable: false,
        });
    });

    it("treats a parse/unknown error with no status as non-retryable", () => {
        expect(classifyProviderError(new SyntaxError("Unexpected token < in JSON"))).toEqual({
            kind: "provider",
            retryable: false,
        });
    });

    it("reads a status nested on the cause chain", () => {
        const wrapped = new Error("wrapped", { cause: apiError(402) });
        expect(classifyProviderError(wrapped)).toEqual({
            kind: "budget",
            retryable: false,
        });
    });
});

describe("toProviderError idempotency", () => {
    it("returns an already-constructed ProviderError unchanged", () => {
        // chatStream throws this; streaming-chat's catch re-wraps it. The second
        // wrap must not String() the object into a "[object Object]" message.
        const inner = toProviderError(new Error("Tool result is missing for tool call toolu_1"), "analysis:abc");
        const rewrapped = toProviderError(inner, "analysis:abc");

        expect(rewrapped).toBe(inner);
        expect(rewrapped.message).toBe(inner.message);
        expect(rewrapped.message).not.toBe("[object Object]");
        expect(rewrapped.message).toContain("Tool result is missing");
    });

    it("wraps a plain Error into a provider error carrying its own message", () => {
        const wrapped = toProviderError(new Error("upstream boom"), "analysis:abc");
        expect(wrapped.type).toBe("provider");
        expect(wrapped.message).toBe("upstream boom");
        expect(wrapped.message).not.toBe("[object Object]");
    });
});

describe("isProviderError", () => {
    it("accepts each ProviderError variant and rejects non-ProviderError values", () => {
        expect(isProviderError({ type: "provider", retryable: true, message: "x" })).toBe(true);
        expect(isProviderError({ type: "budget", retryable: false, message: "x" })).toBe(true);
        expect(isProviderError({ type: "tenant-blocked", retryable: false, message: "x" })).toBe(true);

        expect(isProviderError(new Error("plain"))).toBe(false);
        expect(isProviderError(null)).toBe(false);
        expect(isProviderError("string")).toBe(false);
        expect(isProviderError({ type: "provider", message: "missing retryable" })).toBe(false);
    });
});
