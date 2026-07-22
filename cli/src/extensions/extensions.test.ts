import { describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";

// Side-effect import: installs JSON.parseWith / Response.jsonWith / Date.relativeAge / Promise.sleep /
// Number.prototype.formatBytes,
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

    test("a non-finite `since` renders 0s rather than a NaN string", () => {
        expect(Date.relativeAge(NaN)).toBe("0s");
        expect(Date.relativeAge(Infinity)).toBe("0s");
        expect(Date.relativeAge(-Infinity)).toBe("0s");
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

    test("a sub-second span that rounds up to 1000ms reads 1.0s, never 1000ms", () => {
        // The branch is decided on the rounded value, so 999.6ms crosses into the seconds range instead
        // of printing an out-of-range "1000ms".
        expect(Date.formatDuration(999.6)).toBe("1.0s");
        expect(Date.formatDuration(999.4)).toBe("999ms"); // rounds down → stays in the ms range
    });

    test("a minute or more renders minutes + zero-padded seconds, no spaces", () => {
        expect(Date.formatDuration(60_000)).toBe("1m00s"); // the seconds→minutes boundary
        expect(Date.formatDuration(125_000)).toBe("2m05s");
        expect(Date.formatDuration(4_330_000)).toBe("72m10s"); // large spans stay in minutes
    });

    test("clamps a negative duration to 0ms", () => {
        expect(Date.formatDuration(-5)).toBe("0ms");
    });

    test("a non-finite duration renders 0ms rather than a NaN string", () => {
        expect(Date.formatDuration(NaN)).toBe("0ms");
        expect(Date.formatDuration(Infinity)).toBe("0ms");
        expect(Date.formatDuration(-Infinity)).toBe("0ms");
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

describe("Number.prototype.formatBytes", () => {
    test("renders whole bytes below the first unit step", () => {
        expect((0).formatBytes()).toBe("0 B");
        expect((812).formatBytes()).toBe("812 B");
        expect((1023).formatBytes()).toBe("1023 B"); // upper edge of the bytes range
    });

    test("each unit steps at 1024 of the one below it", () => {
        expect((1024).formatBytes()).toBe("1.0 KB"); // the bytes→KB boundary
        expect((1_048_064).formatBytes()).toBe("1023.5 KB"); // upper edge of the KB range
        expect((1024 ** 2).formatBytes()).toBe("1.0 MB"); // the KB→MB boundary
        expect((37_748_736).formatBytes()).toBe("36.0 MB");
        expect((1024 ** 3).formatBytes()).toBe("1.0 GB"); // the MB→GB boundary
        expect((1_503_238_553).formatBytes()).toBe("1.4 GB");
    });

    test("GB is the top unit — a terabyte-scale count keeps counting in GB", () => {
        expect((1024 ** 4).formatBytes()).toBe("1024.0 GB");
    });

    test("a count that rounds up at the top of a range promotes instead of printing a unit that does not exist", () => {
        // Each of these is a hair under the next unit, so one-decimal rounding would carry it to
        // "1024" in its own unit — a reading no scale uses.
        expect((1023.6).formatBytes()).toBe("1.0 KB");
        expect((1024 ** 2 - 1).formatBytes()).toBe("1.0 MB");
        expect((1024 ** 3 - 1).formatBytes()).toBe("1.0 GB");
    });

    test("clamps a negative count to 0 B", () => {
        expect((-5).formatBytes()).toBe("0 B");
    });

    test("a non-finite count renders 0 B rather than a NaN string", () => {
        expect(NaN.formatBytes()).toBe("0 B");
        expect(Infinity.formatBytes()).toBe("0 B");
        expect((-Infinity).formatBytes()).toBe("0 B");
    });
});
