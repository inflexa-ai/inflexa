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

    test("below a minute renders a single seconds unit", () => {
        const now = spyOn(Date, "now").mockReturnValue(NOW);
        try {
            expect(Date.relativeAge(NOW)).toBe("0s");
            expect(Date.relativeAge(NOW - 5_000)).toBe("5s");
            expect(Date.relativeAge(NOW - 59_000)).toBe("59s"); // upper edge of the seconds range
        } finally {
            now.mockRestore();
        }
    });

    test("from a minute up renders the largest unit plus the next one down, zero-padded", () => {
        const now = spyOn(Date, "now").mockReturnValue(NOW);
        try {
            expect(Date.relativeAge(NOW - 60_000)).toBe("1m00s"); // the seconds→minutes boundary
            expect(Date.relativeAge(NOW - 305_000)).toBe("5m05s"); // second unit zero-pads to two digits
            expect(Date.relativeAge(NOW - 331_000)).toBe("5m31s");
            expect(Date.relativeAge(NOW - 3_599_000)).toBe("59m59s"); // upper edge of the minutes range
            expect(Date.relativeAge(NOW - 3_600_000)).toBe("1h00m"); // the minutes→hours boundary
            expect(Date.relativeAge(NOW - 32_040_000)).toBe("8h54m");
            expect(Date.relativeAge(NOW - 86_340_000)).toBe("23h59m"); // upper edge of the hours range
            expect(Date.relativeAge(NOW - 86_400_000)).toBe("1d00h"); // the hours→days boundary
            expect(Date.relativeAge(NOW - 187_200_000)).toBe("2d04h");
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

describe("Date.formatDuration", () => {
    test("sub-second spans render whole milliseconds", () => {
        expect(Date.formatDuration(14)).toBe("14ms");
        expect(Date.formatDuration(0)).toBe("0ms");
        expect(Date.formatDuration(999)).toBe("999ms"); // upper edge of the ms range
    });

    test("under-a-minute spans render one decimal second", () => {
        expect(Date.formatDuration(1000)).toBe("1.0s"); // first value past the ms range
        expect(Date.formatDuration(1400)).toBe("1.4s");
        expect(Date.formatDuration(59_900)).toBe("59.9s");
        expect(Date.formatDuration(59_999)).toBe("60.0s"); // still the seconds branch (rounds up to 60.0)
    });

    test("a minute or more renders minutes + zero-padded seconds, no spaces", () => {
        expect(Date.formatDuration(60_000)).toBe("1m00s"); // the seconds→minutes boundary
        expect(Date.formatDuration(125_000)).toBe("2m05s");
        expect(Date.formatDuration(4_330_000)).toBe("72m10s"); // large spans stay in minutes
    });

    test("clamps a negative duration to 0ms", () => {
        expect(Date.formatDuration(-5)).toBe("0ms");
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
