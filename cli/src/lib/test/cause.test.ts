import { describe, expect, test } from "bun:test";

import { causeDetailLines, chainCarriesCode, describeCause, errorOf, findAuthCause, messageOf } from "../cause.ts";

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

describe("findAuthCause", () => {
    // The exact harness ProviderError auth shape as it crosses the turn boundary.
    const authValue = { type: "auth", retryable: false, message: "Provider rejected the credential for chat — it is expired, revoked, or absent" };

    test("matches the ProviderError auth shape directly", () => {
        expect(findAuthCause(authValue)?.message).toContain("credential");
    });

    test("finds the auth value nested on an Error cause chain (the wrapped wire shape)", () => {
        const wrapped = new Error("ResultError: turn failed", { cause: new Error("AI_APICallError", { cause: authValue }) });
        expect(findAuthCause(wrapped)?.message).toContain("credential");
    });

    test("finds the auth value inside an AggregateError member", () => {
        const agg = new AggregateError([new Error("other"), Object.assign(new Error("x"), { cause: authValue })], "agg");
        expect(findAuthCause(agg)).not.toBeNull();
    });

    test("a type:auth without retryable:false does not match — shape guard, not name match", () => {
        expect(findAuthCause({ type: "auth", message: "some other domain's auth error" })).toBeNull();
    });

    test("a chain deeper than the depth bound yields null instead of walking forever", () => {
        let chain: unknown = authValue;
        for (let i = 0; i < 10; i++) chain = new Error(`wrapper-${i}`, { cause: chain });
        expect(findAuthCause(chain)).toBeNull();
    });

    test("a self-referential chain terminates at the bound", () => {
        const cyclic: { type: string; cause?: unknown } = { type: "loop" };
        cyclic.cause = cyclic;
        expect(findAuthCause(cyclic)).toBeNull();
    });

    test("non-object and null causes yield null", () => {
        expect(findAuthCause("auth")).toBeNull();
        expect(findAuthCause(null)).toBeNull();
        expect(findAuthCause(undefined)).toBeNull();
    });
});

describe("messageOf", () => {
    test("an Error gives its bare message, with no name prefix and no cause tail", () => {
        expect(messageOf(new TypeError("nope"))).toBe("nope");
        expect(messageOf(new Error("outer", { cause: new Error("inner") }))).toBe("outer");
    });

    test("a string gives itself", () => {
        expect(messageOf("plain text")).toBe("plain text");
    });

    test("a primitive gives the text that String gives", () => {
        expect(messageOf(42)).toBe("42");
        expect(messageOf(true)).toBe("true");
        expect(messageOf(10n)).toBe("10");
        expect(messageOf(Symbol("tag"))).toBe("Symbol(tag)");
        expect(messageOf(null)).toBe("null");
    });

    test("undefined gives the text undefined", () => {
        expect(messageOf(undefined)).toBe("undefined");
    });

    test("a { type, message } object gives `type: message`", () => {
        expect(messageOf({ type: "provider", message: "rate limited" })).toBe("provider: rate limited");
    });

    test("a plain object gives its JSON, never [object Object]", () => {
        expect(messageOf({ code: 7 })).toBe('{"code":7}');
    });
});

describe("errorOf", () => {
    test("an Error gives the same instance", () => {
        const error = new RangeError("out");
        expect(errorOf(error)).toBe(error);
    });

    test("a structural lookalike, a string, and undefined give undefined", () => {
        expect(errorOf({ name: "Error", message: "lookalike" })).toBeUndefined();
        expect(errorOf("text")).toBeUndefined();
        expect(errorOf(undefined)).toBeUndefined();
        expect(errorOf(null)).toBeUndefined();
    });
});

describe("chainCarriesCode", () => {
    function withCode(code: string, cause?: unknown): Error {
        return Object.assign(new Error(`failed with ${code}`), { code }, cause === undefined ? {} : { cause });
    }

    test("a code on the value itself matches", () => {
        expect(chainCarriesCode(withCode("ENOSPC"), "ENOSPC")).toBe(true);
    });

    test("a code on a wrapped cause matches", () => {
        const wrapped = new Error("outer", { cause: new Error("middle", { cause: withCode("ENOSPC") }) });
        expect(chainCarriesCode(wrapped, "ENOSPC")).toBe(true);
    });

    test("a plain object with a code matches, because a link is read structurally", () => {
        expect(chainCarriesCode({ code: "ENOSPC" }, "ENOSPC")).toBe(true);
        expect(chainCarriesCode({ cause: { code: "ENOSPC" } }, "ENOSPC")).toBe(true);
    });

    test("a different code does not match", () => {
        expect(chainCarriesCode(withCode("ENOENT"), "ENOSPC")).toBe(false);
    });

    test("the walk stops after five links", () => {
        let chain: unknown = withCode("ENOSPC");
        for (let link = 0; link < 4; link++) chain = new Error(`wrapper-${link}`, { cause: chain });
        expect(chainCarriesCode(chain, "ENOSPC")).toBe(true);
        chain = new Error("wrapper-4", { cause: chain });
        expect(chainCarriesCode(chain, "ENOSPC")).toBe(false);
    });

    test("a self-referential chain ends", () => {
        const cyclic: { cause?: unknown } = {};
        cyclic.cause = cyclic;
        expect(chainCarriesCode(cyclic, "ENOSPC")).toBe(false);
    });

    test("a value with no code gives false", () => {
        expect(chainCarriesCode(new Error("plain"), "ENOSPC")).toBe(false);
        expect(chainCarriesCode("ENOSPC", "ENOSPC")).toBe(false);
        expect(chainCarriesCode(undefined, "ENOSPC")).toBe(false);
        expect(chainCarriesCode(null, "ENOSPC")).toBe(false);
    });
});
