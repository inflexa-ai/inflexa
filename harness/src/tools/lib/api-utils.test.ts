import { afterEach, describe, expect, it } from "bun:test";
import { z } from "zod";

import { apiFetchValidated, describeApiError, isUnexpectedApiError } from "./api-utils.js";

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
});
