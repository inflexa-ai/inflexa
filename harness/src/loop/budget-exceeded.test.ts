/**
 * Tests for the billing gateway 402 `budget_exceeded` classifier.
 *
 * Verifies the .cause-chain walk + statusCode === 402 primary match.
 */

import { describe, expect, it } from "bun:test";

import { toThrowable } from "../lib/result.js";
import { toProviderError } from "../providers/errors.js";
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

describe("a classification outranks the text heuristic", () => {
    /** A 400 whose response body happens to talk about budgets. */
    const bodyMentionsBudget = () =>
        toProviderError(Object.assign(new Error("Bad Request"), { status: 400, responseBody: '{"error":"budget exceeded for this org"}' }), "analysis:abc");

    it("does NOT treat a provider 400 as a budget stop just because its body says so", () => {
        const wrapped = bodyMentionsBudget();
        // The excerpt is genuinely in the message — this is not passing by accident.
        expect(wrapped.message).toContain("budget exceeded");
        expect(wrapped.type).toBe("provider");

        expect(isBudgetExceeded(wrapped)).toBe(false);
        // ...and through the boundary bridge, which is the shape callers catch.
        expect(isBudgetExceeded(toThrowable(wrapped))).toBe(false);
    });

    it("still recognizes a genuine budget arm", () => {
        const budget = toProviderError(Object.assign(new Error("no funds"), { status: 402 }), "analysis:abc");
        expect(budget.type).toBe("budget");

        expect(isBudgetExceeded(budget)).toBe(true);
        expect(isBudgetExceeded(toThrowable(budget))).toBe(true);
    });

    it("leaves the text fallback intact for throwables nothing classified", () => {
        // The gateway surfacing a billing failure as plain text has no ProviderError
        // anywhere on its chain, so the patterns still decide.
        expect(isBudgetExceeded(new Error("VK budget exceeded: 105.50 > 100.00 dollars"))).toBe(true);
    });

    it("leaves the text fallback intact for a statusless provider arm — no status, no classification", () => {
        // A gateway that reports budget_exceeded in prose and attaches no status
        // still reaches `toProviderError`, which wraps it as `provider` by
        // fall-through. That default must not be read as a verdict, or the backstop
        // is silenced in exactly the case it exists for.
        const statusless = toProviderError(new Error("upstream said: budget exceeded for VK"), "analysis:abc");
        expect(statusless.type).toBe("provider");

        // `toThrowable` is the shape a caller catches: `unwrapOrThrow` bridges the
        // value into a `ResultError` carrying the ProviderError's message. The text
        // branch reads `.message` off an `Error`, so this — not the bare value — is
        // what the patterns have ever been able to see.
        expect(isBudgetExceeded(toThrowable(statusless))).toBe(true);
    });
});
