import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

// Side-effect import: installs JSON.parseWith / Response.jsonWith / Date.relativeAge / Promise.sleep,
// via the same central loader the app uses — so this also catches a loader that forgot an ext file.
import "./index.ts";

describe("JSON.parseWith", () => {
    const schema = z.object({ a: z.number() });

    test("returns the parsed value when the JSON is valid and matches the schema", () => {
        expect(JSON.parseWith('{"a":1}', schema)).toEqual({ a: 1 });
    });

    test("returns null on malformed JSON", () => {
        expect(JSON.parseWith("{not json", schema)).toBeNull();
    });

    test("returns null when valid JSON fails the schema", () => {
        expect(JSON.parseWith('{"a":"not-a-number"}', schema)).toBeNull();
    });
});

describe("Response.prototype.jsonWith", () => {
    const schema = z.object({ a: z.number() });

    test("returns the parsed body when valid", async () => {
        expect(await new Response('{"a":1}').jsonWith(schema)).toEqual({ a: 1 });
    });

    test("returns null on a non-JSON body", async () => {
        expect(await new Response("not json").jsonWith(schema)).toBeNull();
    });

    test("returns null when the body fails the schema", async () => {
        expect(await new Response('{"a":"not-a-number"}').jsonWith(schema)).toBeNull();
    });
});

describe("Date.relativeAge", () => {
    // Pin the clock so bucket boundaries are exact rather than racing real time.
    const NOW = 1_700_000_000_000;

    test("formats the largest whole unit that fits", () => {
        const now = spyOn(Date, "now").mockReturnValue(NOW);
        try {
            expect(Date.relativeAge(NOW)).toBe("0s");
            expect(Date.relativeAge(NOW - 5_000)).toBe("5s");
            expect(Date.relativeAge(NOW - 59_000)).toBe("59s");
            expect(Date.relativeAge(NOW - 60_000)).toBe("1m");
            expect(Date.relativeAge(NOW - 90 * 60_000)).toBe("1h");
            expect(Date.relativeAge(NOW - 25 * 3_600_000)).toBe("1d");
        } finally {
            now.mockRestore();
        }
    });

    test("clamps a future timestamp (clock skew) to 0s", () => {
        const now = spyOn(Date, "now").mockReturnValue(NOW);
        try {
            expect(Date.relativeAge(NOW + 10_000)).toBe("0s");
        } finally {
            now.mockRestore();
        }
    });
});

describe("Promise.sleep", () => {
    test("resolves only after roughly the requested delay", async () => {
        const start = Date.now();
        await Promise.sleep(20);
        // Allow scheduler slack below the nominal 20ms, but it must have actually waited.
        expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    });
});
