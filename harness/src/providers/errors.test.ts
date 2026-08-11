import { describe, expect, it } from "bun:test";

import { classifyProviderError, isProviderError, RequestTimeoutError, toProviderError } from "./errors.js";

/** Build a synthetic API error carrying an HTTP status, SDK-shaped. */
function apiError(status: number): Error {
    return Object.assign(new Error(`HTTP ${status}`), { status });
}

/**
 * The shape the AI SDK actually hands over when a 4xx body fails to parse
 * against the configured provider's error schema: the message degrades to
 * `response.statusText`, while the raw bytes survive on `responseBody`.
 */
function nonConformingApiError(status: number, reasonPhrase: string, responseBody?: string): Error {
    return Object.assign(new Error(reasonPhrase), { status, ...(responseBody === undefined ? {} : { responseBody }) });
}

describe("classifyProviderError", () => {
    it("classifies a 401 as a non-retryable auth error", () => {
        // The field failure: an expired OAuth access token reached a step as a
        // bare non-retryable 4xx, indistinguishable from a malformed request, so
        // nothing downstream could say "re-authenticate".
        expect(classifyProviderError(apiError(401))).toEqual({
            kind: "auth",
            retryable: false,
        });
    });

    it("reads a 401 nested on the cause chain (the AI SDK wraps it)", () => {
        const wrapped = Object.assign(new Error("AI_APICallError"), { cause: apiError(401) });
        expect(classifyProviderError(wrapped)).toEqual({ kind: "auth", retryable: false });
    });

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

describe("the request-timeout sentinel", () => {
    it("classifies a bare sentinel as a retryable provider timeout", () => {
        expect(classifyProviderError(new RequestTimeoutError(30_000))).toEqual({ kind: "provider", retryable: true });
    });

    it("reads the sentinel nested on the cause chain the same way the SDK wraps it", () => {
        const wrapped = new Error("AI_APICallError", { cause: new RequestTimeoutError(30_000) });
        expect(classifyProviderError(wrapped)).toEqual({ kind: "provider", retryable: true });
    });

    it("names the configured value and the workload in the composed message", () => {
        const err = toProviderError(new RequestTimeoutError(45_000), "analysis:abc");
        expect(err.type).toBe("provider");
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("45000");
        expect(err.message).toContain("analysis:abc");
    });

    it("wins over the connection-error path when both match the same throwable", () => {
        // A guard abort can ride under a `fetch failed` wrapper. The sentinel
        // detection runs first, thus the message names the configured value, not a
        // bare connection failure.
        const wrapped = new TypeError("fetch failed", { cause: new RequestTimeoutError(20_000) });
        const err = toProviderError(wrapped, "analysis:abc");
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("20000");
    });
});

describe("the SDK timeout", () => {
    /** The abort reason of the SDK chunk bound: a bare DOMException, no cause. */
    function sdkChunkTimeout(ms: number): DOMException {
        return new DOMException(`Chunk timeout of ${ms}ms exceeded`, "TimeoutError");
    }

    it("classifies a bare TimeoutError as a retryable provider timeout", () => {
        expect(classifyProviderError(sdkChunkTimeout(30_000))).toEqual({ kind: "provider", retryable: true });
    });

    it("reads a TimeoutError nested on the cause chain", () => {
        const wrapped = new Error("AI_APICallError", { cause: sdkChunkTimeout(30_000) });
        expect(classifyProviderError(wrapped)).toEqual({ kind: "provider", retryable: true });
    });

    it("falls back to the message of the SDK, which names the configured value", () => {
        const err = toProviderError(sdkChunkTimeout(45_000), "analysis:abc");
        expect(err.type).toBe("provider");
        expect(err.retryable).toBe(true);
        expect(err.message).toContain("45000");
        expect(err.message).toContain("analysis:abc");
    });

    it("keeps a wrapped TimeoutError retryable, where an unknown throwable is not", () => {
        // The retry envelope wraps the last failure of an exhausted attempt. The
        // wrapper carries no status and no connection text, thus only the timeout
        // probe on the cause chain keeps the classification retryable.
        const exhausted = new Error("Failed after 3 attempts.", { cause: sdkChunkTimeout(20_000) });
        expect(classifyProviderError(exhausted).retryable).toBe(true);
        expect(classifyProviderError(new Error("Failed after 3 attempts.")).retryable).toBe(false);
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

    it("wraps a 401 into an auth error whose message names the credential, not the request", () => {
        const err = toProviderError(apiError(401), "chat");
        expect(err.type).toBe("auth");
        expect(err.retryable).toBe(false);
        expect(err.message).toMatch(/credential/i);
        expect(isProviderError(err)).toBe(true);
    });

    it("wraps a plain Error into a provider error naming the workload alongside the detail", () => {
        const wrapped = toProviderError(new Error("upstream boom"), "analysis:abc");
        expect(wrapped.type).toBe("provider");
        expect(wrapped.message).toBe("Provider call failed for analysis:abc: upstream boom");
        expect(wrapped.message).not.toBe("[object Object]");
        // No status was extractable, so none is claimed.
        expect(wrapped.message).not.toContain("HTTP");
    });
});

describe("the provider arm's composed message", () => {
    it("names the workload and the status when a 400 body degrades to its reason phrase", () => {
        // inflexa#258: the local proxy answered 400 with a body that does not match
        // the Anthropic error envelope, so the SDK message was the bare phrase and
        // the whole account of a failed profiling run read `Bad Request.`
        const wrapped = toProviderError(nonConformingApiError(400, "Bad Request"), "analysis:abc");

        expect(wrapped.type).toBe("provider");
        expect(wrapped.retryable).toBe(false);
        expect(wrapped.message).toBe("Provider call failed for analysis:abc (HTTP 400): Bad Request");
        expect(wrapped.message).not.toBe("Bad Request");
    });

    it("reads the status off the cause chain, the same links classification walks", () => {
        const wrapped = toProviderError(new Error("wrapped", { cause: nonConformingApiError(429, "Too Many Requests") }), "analysis:abc");

        expect(wrapped.message).toContain("(HTTP 429)");
        expect(wrapped.retryable).toBe(true);
    });

    it("preserves a captured response body as a single-lined excerpt", () => {
        const wrapped = toProviderError(
            nonConformingApiError(400, "Bad Request", '{\n  "error": "model \'claude-x\' is not enabled for this credential"\n}'),
            "analysis:abc",
        );

        expect(wrapped.message).toContain("response body:");
        expect(wrapped.message).toContain('"error": "model \'claude-x\' is not enabled for this credential"');
        // Single-lined: the ledger column and every log sink take one line.
        expect(wrapped.message).not.toContain("\n");
    });

    it("caps the excerpt at 120 characters so it can never evict the workload and status", () => {
        const body = "x".repeat(500);
        const wrapped = toProviderError(nonConformingApiError(400, "Bad Request", body), "analysis:abc");

        const excerpt = wrapped.message.split("response body: ")[1]!;
        expect(excerpt.length).toBe(120);
        expect(excerpt.endsWith("…")).toBe(true);
        // The lead survives, and leads: truncation downstream eats the excerpt first.
        expect(wrapped.message.startsWith("Provider call failed for analysis:abc (HTTP 400): Bad Request")).toBe(true);
    });

    it("ignores a blank response body rather than trailing an empty segment", () => {
        const wrapped = toProviderError(nonConformingApiError(400, "Bad Request", "   \n  "), "analysis:abc");
        expect(wrapped.message).toBe("Provider call failed for analysis:abc (HTTP 400): Bad Request");
    });

    it("still identifies the failure when the transport supplies no reason phrase", () => {
        // An HTTP/2 hop carries no reason phrase, so `statusText` — and with it the
        // SDK message — is empty. The message must not collapse to nothing.
        const wrapped = toProviderError(nonConformingApiError(400, ""), "analysis:abc");

        expect(wrapped.message).toBe("Provider call failed for analysis:abc (HTTP 400)");
        expect(wrapped.message.endsWith(":")).toBe(false);
    });

    it("keeps the composed message inside the ledger's 200-character line", () => {
        // `profileFailureReason` (tasks/data-profile.ts) truncates at 200 and this is
        // the tightest consumer; the lead must survive that cut intact.
        const wrapped = toProviderError(
            nonConformingApiError(400, "Bad Request", '{"error":{"message":"upstream credential rejected the request"}}'),
            "analysis:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
        );

        expect(wrapped.message.slice(0, 200)).toContain("(HTTP 400)");
        expect(wrapped.message.slice(0, 200)).toContain("response body:");
    });

    it("does not let message composition move an arm: same status, different bodies, same classification", () => {
        const a = toProviderError(nonConformingApiError(400, "Bad Request", '{"error":"budget exceeded"}'), "analysis:abc");
        const b = toProviderError(nonConformingApiError(400, "Bad Request", '{"error":"unknown model"}'), "analysis:abc");

        expect(a.type).toBe(b.type);
        expect(a.retryable).toBe(b.retryable);
        expect(a.message).not.toBe(b.message);
        // Classification keys on the status alone — a body that reads like another
        // arm's prose does not become that arm.
        expect(a.type).toBe("provider");
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
