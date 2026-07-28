import { describe, expect, test } from "bun:test";

import { turnSubmitAction } from "./app.tsx";

// The normal-turn submit gates are derived by the pure `turnSubmitAction` (app.tsx) and executed by
// `handleSubmit`. Booting the whole chat App to pin them would drag in a runtime, Postgres, and
// providers for what is a four-way precedence — so, exactly as ask_answer.test.ts and
// interrupt_hint.test.ts do for the other two derivations, the decision is exercised directly.
//
// The unbound-thread case is the one this file exists for: it is reachable only inside a real race
// between the `ready` edge and the Postgres round-trip that binds the thread, which no test can stage
// against a live runtime. Keeping the decision pure is what makes that window assertable at all.

/** A ready runtime with both ids bound: the only state from which a turn may run. */
const READY = { busy: false, ready: true, analysisId: "ana1", sessionId: "thr1" };

describe("turnSubmitAction — the normal-turn submit gates", () => {
    test("ready + a bound thread → send, carrying both ids", () => {
        expect(turnSubmitAction(READY)).toEqual({ kind: "send", sessionId: "thr1", analysisId: "ana1" });
    });

    test("ready + no bound thread → the unbound refusal (an info notice, never a send)", () => {
        const action = turnSubmitAction({ ...READY, sessionId: null });
        expect(action).toEqual({ kind: "unbound" });
        // `send` is the ONLY outcome `handleSubmit` clears the composer on, so asserting the kind is
        // asserting that the draft survives: any non-send verdict returns before the clear.
        expect(action.kind).not.toBe("send");
    });

    test("no analysis → the error-banner refusal, ahead of the thread check", () => {
        // Ordering matters: with both missing, the analysis gate wins, so the user sees the real fault
        // rather than a "still opening" notice that would never resolve.
        expect(turnSubmitAction({ ...READY, analysisId: null })).toEqual({ kind: "no-analysis" });
        expect(turnSubmitAction({ ...READY, analysisId: null, sessionId: null })).toEqual({ kind: "no-analysis" });
    });

    test("still booting → wait, whatever the ids say (the pre-existing gate is unchanged)", () => {
        expect(turnSubmitAction({ ...READY, ready: false })).toEqual({ kind: "wait" });
        expect(turnSubmitAction({ ...READY, ready: false, sessionId: null })).toEqual({ kind: "wait" });
        expect(turnSubmitAction({ ...READY, ready: false, analysisId: null })).toEqual({ kind: "wait" });
    });

    test("a turn already running → wait, outranking every later gate", () => {
        expect(turnSubmitAction({ ...READY, busy: true })).toEqual({ kind: "wait" });
        expect(turnSubmitAction({ ...READY, busy: true, sessionId: null })).toEqual({ kind: "wait" });
    });

    test("an empty-string id is a bound id — only null refuses", () => {
        // The gates test for null explicitly rather than truthiness, so an id the store legitimately
        // holds as "" would still send. Pinning it keeps a future `!opts.sessionId` from sneaking in
        // and turning a valid bind into a permanent refusal.
        expect(turnSubmitAction({ ...READY, sessionId: "" })).toEqual({ kind: "send", sessionId: "", analysisId: "ana1" });
    });
});
