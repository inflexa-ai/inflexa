import { describe, expect, test } from "bun:test";

import { causeDetailLines, describeCause } from "./cause.ts";

describe("describeCause", () => {
    test("an Error renders `name: message`", () => {
        expect(describeCause(new Error("boom"))).toBe("Error: boom");
        expect(describeCause(new TypeError("nope"))).toBe("TypeError: nope");
    });

    test("an Error with a nested Error cause appends one level", () => {
        const inner = new TypeError("inner exploded");
        const outer = new Error("outer wrapper", { cause: inner });
        expect(describeCause(outer)).toBe("Error: outer wrapper (cause: TypeError: inner exploded)");
    });

    test("an Error with a structured object cause appends the discriminant + message", () => {
        const outer = new Error("wire call failed", { cause: { type: "provider", message: "rate limited" } });
        expect(describeCause(outer)).toBe("Error: wire call failed (cause: provider: rate limited)");
    });

    test("a discriminated error renders `type: message`", () => {
        expect(describeCause({ type: "provider", retryable: true, message: "rate limited" })).toBe("provider: rate limited");
    });

    test("a discriminated error with no message renders just the type", () => {
        expect(describeCause({ type: "x" })).toBe("x");
        // An empty-string message falls back to the bare discriminant, not `x: `.
        expect(describeCause({ type: "x", message: "" })).toBe("x");
    });

    test("a plain object renders bounded JSON, never `[object Object]`", () => {
        const line = describeCause({ foo: "bar", n: 1 });
        expect(line).toBe('{"foo":"bar","n":1}');
        expect(line).not.toContain("[object Object]");
    });

    test("a circular object does not throw", () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        expect(() => describeCause(circular)).not.toThrow();
        expect(describeCause(circular)).toContain("[Circular]");
    });

    test("a string is returned as-is", () => {
        expect(describeCause("plain failure text")).toBe("plain failure text");
    });

    test("undefined and null render via String", () => {
        expect(describeCause(undefined)).toBe("undefined");
        expect(describeCause(null)).toBe("null");
    });
});

describe("causeDetailLines", () => {
    test("an Error includes its headline and stack frames", () => {
        const lines = causeDetailLines(new Error("boom"));
        expect(lines[0]).toBe("Error: boom");
        // Some stack frame is present, and the headline is not duplicated as the second line.
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.some((l) => l.includes("at "))).toBe(true);
    });

    test("a nested Error cause is rendered as an indented `caused by:` section", () => {
        const outer = new Error("outer", { cause: new Error("inner") });
        const lines = causeDetailLines(outer);
        expect(lines[0]).toBe("Error: outer");
        expect(lines).toContain("caused by:");
        // The nested section is indented and carries the inner headline.
        expect(lines.some((l) => l === "  Error: inner")).toBe(true);
    });

    test("an object cause is rendered as pretty JSON under `caused by:`", () => {
        const outer = new Error("wrap", { cause: { type: "io", detail: "disk full" } });
        const lines = causeDetailLines(outer);
        expect(lines).toContain("caused by:");
        expect(lines.some((l) => l.includes('"type": "io"'))).toBe(true);
    });

    test("a plain object is pretty-printed as JSON", () => {
        const lines = causeDetailLines({ type: "provider", message: "rate limited" });
        expect(lines.join("\n")).toContain('"type": "provider"');
        expect(lines.join("\n")).toContain('"message": "rate limited"');
    });

    test("a circular object does not throw and marks the cycle", () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        expect(() => causeDetailLines(circular)).not.toThrow();
        expect(causeDetailLines(circular).join("\n")).toContain("[Circular]");
    });

    test("a string is split into its own lines", () => {
        expect(causeDetailLines("one\ntwo")).toEqual(["one", "two"]);
    });

    test("undefined and null render a single String line", () => {
        expect(causeDetailLines(undefined)).toEqual(["undefined"]);
        expect(causeDetailLines(null)).toEqual(["null"]);
    });
});

// AggregateError is the shape a failed `fetch` throws under Bun/undici (each address tried becomes a
// sub-error), and the shape `Promise.any` throws. Its own message names the aggregation, never the
// failure — so a renderer that stops at `name: message` prints "All promises were rejected" and drops
// every ECONNREFUSED the user needs.
describe("describeCause — AggregateError", () => {
    test("summarizes the sub-errors the headline omits", () => {
        const agg = new AggregateError([new Error("ECONNREFUSED ::1:8317"), new Error("ECONNREFUSED 127.0.0.1:8317")], "All promises were rejected");
        const line = describeCause(agg);
        expect(line).toContain("AggregateError: All promises were rejected");
        expect(line).toContain("2 errors");
        expect(line).toContain("ECONNREFUSED ::1:8317");
        expect(line).toContain("ECONNREFUSED 127.0.0.1:8317");
    });

    test("stays one line: elides past the first three and clamps the length", () => {
        const agg = new AggregateError(
            [1, 2, 3, 4, 5].map((n) => new Error(`e${n}`)),
            "many",
        );
        const line = describeCause(agg);
        expect(line).toContain("5 errors");
        expect(line).toContain("+2 more");
        expect(line).not.toContain("e4");
        expect(line.includes("\n")).toBe(false);

        const fat = new AggregateError([new Error("x".repeat(500))], "fat");
        expect(describeCause(fat).length).toBeLessThan(300);
        expect(describeCause(fat)).toContain("…");
    });

    test("sub-errors win over .cause — the aggregate's members are the failure", () => {
        const agg = new AggregateError([new Error("inner")], "outer");
        agg.cause = new Error("context");
        const line = describeCause(agg);
        expect(line).toContain("inner");
        expect(line).not.toContain("cause: Error: context");
    });

    test("an empty aggregate degrades to the plain Error rendering", () => {
        expect(describeCause(new AggregateError([], "nothing"))).toBe("AggregateError: nothing");
    });

    test("a discriminated domain error inside an aggregate renders by its type", () => {
        const agg = new AggregateError([{ type: "proxy_unreachable", message: "connect failed" }], "all failed");
        expect(describeCause(agg)).toContain("proxy_unreachable: connect failed");
    });
});

describe("causeDetailLines — AggregateError", () => {
    test("each sub-error gets its own indented section", () => {
        const agg = new AggregateError([new Error("first"), new Error("second")], "both failed");
        const lines = causeDetailLines(agg);
        expect(lines[0]).toBe("AggregateError: both failed");
        // The label sits at the parent's level and only its content indents — the same shape as `caused by:`.
        expect(lines).toContain("errors[0]:");
        expect(lines).toContain("errors[1]:");
        expect(lines).toContain("  Error: first");
        expect(lines).toContain("  Error: second");
    });

    test("sub-error sections precede the `caused by:` section", () => {
        const agg = new AggregateError([new Error("member")], "agg");
        agg.cause = new Error("context");
        const lines = causeDetailLines(agg);
        const errorsAt = lines.findIndex((l) => l.trim() === "errors[0]:");
        const causedAt = lines.findIndex((l) => l.trim() === "caused by:");
        expect(errorsAt).toBeGreaterThanOrEqual(0);
        expect(causedAt).toBeGreaterThan(errorsAt);
    });

    test("a nested aggregate recurses and stays bounded", () => {
        const deep = new AggregateError([new AggregateError([new Error("leaf")], "mid")], "top");
        const lines = causeDetailLines(deep);
        expect(lines.some((l) => l.includes("AggregateError: mid"))).toBe(true);
        expect(lines.some((l) => l.includes("Error: leaf"))).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(400);
    });

    test("a self-referential aggregate terminates rather than looping", () => {
        const members: unknown[] = [];
        const agg = new AggregateError(members, "self");
        members.push(agg);
        expect(() => causeDetailLines(agg)).not.toThrow();
        expect(causeDetailLines(agg).length).toBeLessThanOrEqual(400);
    });

    test("a huge aggregate cannot flood the dump", () => {
        const agg = new AggregateError(
            Array.from({ length: 500 }, (_unused, i) => new Error(`e${i}`)),
            "flood",
        );
        expect(causeDetailLines(agg).length).toBeLessThanOrEqual(400);
    });

    test("a non-Error member renders through the normal value path", () => {
        const agg = new AggregateError([{ type: "io", detail: "disk full" }], "agg");
        expect(causeDetailLines(agg).join("\n")).toContain('"type": "io"');
    });
});
