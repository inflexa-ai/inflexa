import { describe, expect, test } from "bun:test";

import { askSubmitAction, parseAskAnswer } from "./app.tsx";

// The composer answer path is derived by two pure functions in app.tsx: `parseAskAnswer` maps a submitted
// buffer to an ask reply (or null), and `askSubmitAction` decides what a submit does while the ask queue
// is consulted. Booting the whole chat App to pin either would drag in a runtime, DB, and providers for
// what is a token map plus a four-way precedence — so, exactly as interrupt_hint.test.ts does for the
// footer hint, the derivations are exercised directly. Keeping the decision pure is what lets the
// answer/swallow/refuse/passthrough precedence be asserted here without a mounted textarea or gateway.

describe("parseAskAnswer — the composer answer-token map", () => {
    test("the three tokens map one-for-one to the prompt's keys", () => {
        expect(parseAskAnswer("y")).toEqual({ kind: "once" });
        expect(parseAskAnswer("a")).toEqual({ kind: "always" });
        expect(parseAskAnswer("n")).toEqual({ kind: "reject" });
    });

    test("tokens are trimmed and case-insensitive", () => {
        expect(parseAskAnswer("  y  ")).toEqual({ kind: "once" });
        expect(parseAskAnswer("Y")).toEqual({ kind: "once" });
        expect(parseAskAnswer("A")).toEqual({ kind: "always" });
        expect(parseAskAnswer("\tN\n")).toEqual({ kind: "reject" });
    });

    test("reject is bare — no feedback key rides the composer path", () => {
        // toEqual with an exact object asserts the ABSENCE of `feedback`: composer-carried reject feedback
        // is deliberately out of scope, so a stray key would be a real regression.
        expect(parseAskAnswer("  N  ")).toEqual({ kind: "reject" });
        expect(parseAskAnswer("n")).not.toHaveProperty("feedback");
    });

    test("anything that is not exactly one token falls through to null (reaches the model as text)", () => {
        for (const text of ["yes", "no", "always", "y approve", "ya", "", "  ", "y\nplease"]) {
            expect(parseAskAnswer(text)).toBeNull();
        }
    });
});

describe("askSubmitAction — the composer-submit precedence while the queue is consulted", () => {
    test("no docked ask → passthrough, even for a token (a bare y is a normal message)", () => {
        expect(askSubmitAction("y", false, false)).toEqual({ kind: "passthrough" });
        expect(askSubmitAction("rerun it", false, false)).toEqual({ kind: "passthrough" });
    });

    test("docked + an answer in flight → swallow, ahead of any token parse", () => {
        // answerBusy outranks the token shape: even a valid `y` is dropped while the first answer resolves.
        expect(askSubmitAction("y", true, true)).toEqual({ kind: "swallow" });
        expect(askSubmitAction("rerun it", true, true)).toEqual({ kind: "swallow" });
    });

    test("docked + a token → answer carrying the parsed reply", () => {
        expect(askSubmitAction("y", true, false)).toEqual({ kind: "answer", reply: { kind: "once" } });
        expect(askSubmitAction("  A  ", true, false)).toEqual({ kind: "answer", reply: { kind: "always" } });
        expect(askSubmitAction("N", true, false)).toEqual({ kind: "answer", reply: { kind: "reject" } });
    });

    test("docked + non-token text → refuse (the draft is kept and the notice fires at the call site)", () => {
        expect(askSubmitAction("rerun it with more threads", true, false)).toEqual({ kind: "refuse" });
        expect(askSubmitAction("yes", true, false)).toEqual({ kind: "refuse" });
    });
});
