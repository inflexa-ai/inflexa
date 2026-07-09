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
