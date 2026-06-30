/**
 * Unit tests for the neverthrow glue in `result.ts`.
 *
 * The load-bearing behavior is the Result→throw bridge: a structured error
 * must survive rethrow with its `cause` chain intact, because the downstream
 * classifiers (`classifyProviderError`, `isBudgetExceeded`) walk `.cause` for
 * a status / connection signal after a `Result` crosses a boundary.
 */

import { describe, expect, it } from "bun:test";
import { err, ok } from "neverthrow";

import { ResultError, isResult, toThrowable, unwrapOrThrow } from "./result.js";

describe("toThrowable", () => {
    it("returns an Error value verbatim", () => {
        const e = new Error("boom");
        expect(toThrowable(e)).toBe(e);
    });

    it("wraps a structured DomainError, keeping the value on .cause", () => {
        const domain = { type: "db_query_failed", cause: { code: "23505" } };
        const thrown = toThrowable(domain);
        expect(thrown).toBeInstanceOf(ResultError);
        expect((thrown as ResultError).value).toBe(domain);
        expect(thrown.cause).toBe(domain);
        expect(thrown.message).toBe("db_query_failed");
    });
});

describe("unwrapOrThrow", () => {
    it("returns the value of an ok", () => {
        expect(unwrapOrThrow(ok(99))).toBe(99);
    });

    it("throws toThrowable(error) on an err", () => {
        expect(() => unwrapOrThrow(err({ type: "boom" }))).toThrow(ResultError);
    });

    it("surfaces a 402 on the rethrown cause chain for budget classification", () => {
        const budgetErr = { type: "budget_exceeded", cause: { status: 402 } };
        try {
            unwrapOrThrow(err(budgetErr));
            throw new Error("expected throw");
        } catch (thrown) {
            // The classifier walks `.cause`: ResultError → domain → { status: 402 }.
            expect((thrown as ResultError).cause).toBe(budgetErr);
        }
    });
});

describe("isResult", () => {
    it("is true for ok and err", () => {
        expect(isResult(ok(1))).toBe(true);
        expect(isResult(err("x"))).toBe(true);
    });

    it("is false for plain values that merely look result-ish", () => {
        expect(isResult({ value: 1 })).toBe(false);
        expect(isResult(null)).toBe(false);
        expect(isResult("ok")).toBe(false);
    });
});
