import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { apiFetchValidated, describeApiError, isUnexpectedApiError, parseWireNumber, zWireNumber } from "./api-utils.js";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

function stubFetch(response: () => Response): void {
    globalThis.fetch = (async () => response()) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const RowSchema = z.object({
    id: z.number(),
    name: z.string().optional(),
});
const ListSchema = z.array(RowSchema);

describe("apiFetchValidated", () => {
    it("returns the parsed value when the response matches the schema", async () => {
        stubFetch(() => json([{ id: 1, name: "TP53" }, { id: 2 }]));

        const res = await apiFetchValidated("https://example.test/x", ListSchema);

        expect(res.isOk()).toBe(true);
        expect(res._unsafeUnwrap()).toEqual([{ id: 1, name: "TP53" }, { id: 2 }]);
    });

    it("rejects a response whose field has the wrong type", async () => {
        // `id` comes back as a string — the kind of upstream contract drift the
        // schema exists to catch, rather than letting a bad value flow downstream.
        stubFetch(() => json([{ id: "not-a-number" }]));

        const res = await apiFetchValidated("https://example.test/x", ListSchema);

        expect(res.isErr()).toBe(true);
        if (res.isErr()) {
            expect(res.error.type).toBe("invalid_response");
            // A schema mismatch is unexpected, so callers surface it rather than
            // treating it as an empty/absent result.
            expect(isUnexpectedApiError(res.error)).toBe(true);
            if (res.error.type === "invalid_response") {
                expect(res.error.issues).toContain("0.id");
            }
        }
    });

    it("rejects a response of the wrong top-level shape", async () => {
        // The endpoint returned an error envelope instead of the expected array.
        stubFetch(() => json({ error: "rate limited" }));

        const res = await apiFetchValidated("https://example.test/x", ListSchema);

        expect(res.isErr()).toBe(true);
        if (res.isErr()) {
            expect(res.error.type).toBe("invalid_response");
        }
    });

    it("propagates an HTTP error without attempting validation", async () => {
        stubFetch(() => json({ message: "boom" }, 500));

        const res = await apiFetchValidated("https://example.test/x", ListSchema, { maxRetries: 0 });

        expect(res.isErr()).toBe(true);
        if (res.isErr()) {
            expect(res.error.type).toBe("http_status");
        }
    });

    it("renders an invalid_response error to a readable message", () => {
        const message = describeApiError({ type: "invalid_response", issues: "0.id: Expected number, received string" });
        expect(message).toBe("Response did not match the expected schema: 0.id: Expected number, received string");
    });

    it("retries a 502 and returns the payload of the next attempt", async () => {
        // A gateway in front of a bio provider answers 502 with an HTML body while
        // the origin restarts. The next attempt gets the real payload, thus 502 is
        // retryable and the caller never sees the transient failure.
        let attempts = 0;
        stubFetch(() => {
            attempts += 1;
            if (attempts === 1) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
            return json([{ id: 7, name: "BRCA1" }]);
        });

        const res = await apiFetchValidated("https://example.test/x", ListSchema, { retryDelayMs: 0 });

        expect(attempts).toBe(2);
        expect(res.isOk()).toBe(true);
        expect(res._unsafeUnwrap()).toEqual([{ id: 7, name: "BRCA1" }]);
    });
});

describe("parseWireNumber", () => {
    it("reads a quoted decimal as a number", () => {
        expect(parseWireNumber("4.0")).toBe(4);
    });

    it("passes a real number through", () => {
        expect(parseWireNumber(2001)).toBe(2001);
    });

    it("gives null for a string that is not a number", () => {
        expect(parseWireNumber("abc")).toBeNull();
    });

    it("gives null for an absent value", () => {
        expect(parseWireNumber(null)).toBeNull();
        expect(parseWireNumber(undefined)).toBeNull();
    });

    it("gives null for an empty string and for NaN", () => {
        // `Number("")` gives 0, thus an empty cell must not become a real value.
        expect(parseWireNumber("")).toBeNull();
        expect(parseWireNumber("   ")).toBeNull();
        expect(parseWireNumber(Number.NaN)).toBeNull();
    });
});

describe("zWireNumber", () => {
    it("transforms each wire encoding to the same output", () => {
        expect(zWireNumber.parse("4.0")).toBe(4);
        expect(zWireNumber.parse(2001)).toBe(2001);
        expect(zWireNumber.parse("abc")).toBeNull();
    });

    it("rejects an absent value until a caller widens it", () => {
        // Absence is a per-provider policy, thus the helper stays strict and the
        // client composes `.nullable()` or `.optional()` over it.
        expect(zWireNumber.safeParse(null).success).toBe(false);
        expect(zWireNumber.nullable().parse(null)).toBeNull();
        expect(zWireNumber.nullable().optional().parse(undefined)).toBeUndefined();
    });
});
