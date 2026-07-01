/**
 * Tests for the billing gateway 402 `budget_exceeded` classifier.
 *
 * Verifies the .cause-chain walk + statusCode === 402 primary match.
 */

import { describe, expect, it } from "bun:test";
import { isBudgetExceeded } from "./budget-exceeded.js";

describe("isBudgetExceeded (harness)", () => {
    it("recognizes billing gateway budget_exceeded error message", () => {
        expect(isBudgetExceeded(new Error("Budget exceeded: VK budget exceeded: 105.50 > 100.00 dollars"))).toBe(true);
    });

    it("does NOT match a bare 402 message without budget_exceeded", () => {
        expect(isBudgetExceeded(new Error("Request failed with status 402"))).toBe(false);
    });

    it("does NOT match transient errors", () => {
        expect(isBudgetExceeded(new Error("Service Unavailable 503"))).toBe(false);
        expect(isBudgetExceeded(new Error("overloaded 529"))).toBe(false);
        expect(isBudgetExceeded(new Error("rate limit exceeded"))).toBe(false);
    });

    it("handles non-Error input gracefully", () => {
        expect(isBudgetExceeded("some string")).toBe(false);
        expect(isBudgetExceeded(null)).toBe(false);
        expect(isBudgetExceeded(undefined)).toBe(false);
        expect(isBudgetExceeded(42)).toBe(false);
    });

    it("recognizes top-level statusCode === 402", () => {
        const err: Error & { statusCode?: number } = new Error("upstream error");
        err.statusCode = 402;
        expect(isBudgetExceeded(err)).toBe(true);
    });

    it("recognizes top-level status === 402 (alternate property name)", () => {
        const err: Error & { status?: number } = new Error("upstream error");
        err.status = 402;
        expect(isBudgetExceeded(err)).toBe(true);
    });

    it("walks the cause chain to find a nested statusCode 402", () => {
        const inner: Error & { statusCode?: number } = new Error("inner 402");
        inner.statusCode = 402;
        const outer = new Error("wrapped", { cause: inner });
        expect(isBudgetExceeded(outer)).toBe(true);
    });

    it("does NOT classify statusCode 429 / 403 as budget exceeded", () => {
        const rl: Error & { statusCode?: number } = new Error("rate limited");
        rl.statusCode = 429;
        expect(isBudgetExceeded(rl)).toBe(false);

        const forbidden: Error & { statusCode?: number } = new Error("forbidden");
        forbidden.statusCode = 403;
        expect(isBudgetExceeded(forbidden)).toBe(false);
    });
});
