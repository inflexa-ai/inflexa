import { beforeEach, describe, expect, test } from "bun:test";

import {
    __resetTurnsForTest,
    abortRunningTurns,
    abortTurn,
    ENDED_TURN_LIMIT,
    endTurn,
    findTurn,
    forgetTurn,
    hasRunningTurn,
    listThreadTurns,
    newTurnsRefused,
    refuseNewTurns,
    runningTurnCount,
    startTurn,
    whenNoRunningTurns,
} from "./turns.ts";

const T0 = new Date("2026-10-02T10:00:00.000Z");

function start(turnId: string, threadId = "t1", analysisId = "a1", at = T0): AbortSignal {
    return startTurn({ turnId, threadId, analysisId }, at);
}

beforeEach(() => {
    __resetTurnsForTest();
});

describe("the turn registry", () => {
    test("a running turn reads as running, and its end records the summary with its duration", () => {
        start("k1");
        expect(findTurn("k1")).toEqual({ turnId: "k1", threadId: "t1", analysisId: "a1", status: "running", startedAt: T0.toISOString() });
        expect(hasRunningTurn("a1")).toBe(true);
        expect(hasRunningTurn("a2")).toBe(false);

        endTurn("k1", { status: "done", opened: true }, new Date(T0.getTime() + 1500));
        expect(findTurn("k1")).toMatchObject({ status: "done", opened: true, endedAt: "2026-10-02T10:00:01.500Z", durationMs: 1500 });
        expect(hasRunningTurn("a1")).toBe(false);
    });

    test("an abort fires the signal of a running turn, and an ended or unknown turn is told apart", () => {
        const signal = start("k1");
        expect(abortTurn("k1")).toBe("aborting");
        expect(signal.aborted).toBe(true);
        endTurn("k1", { status: "aborted", opened: true }, T0);
        expect(abortTurn("k1")).toBe("already_ended");
        expect(abortTurn("nope")).toBeNull();
    });

    test("a refused turn is forgotten with no summary", () => {
        start("k1");
        forgetTurn("k1");
        expect(findTurn("k1")).toBeNull();
        expect(hasRunningTurn("a1")).toBe(false);
    });

    test("the thread list gives the running turns first, then the ended ones, each newest first, of that thread alone", () => {
        start("old", "t1", "a1", new Date(T0.getTime()));
        endTurn("old", { status: "done" }, T0);
        start("newer", "t1", "a1", new Date(T0.getTime() + 1000));
        endTurn("newer", { status: "failed" }, T0);
        start("live", "t1", "a1", new Date(T0.getTime() - 5000));
        start("other", "t2", "a1");
        expect(listThreadTurns("a1", "t1").map((turn) => turn.turnId)).toEqual(["live", "newer", "old"]);
        expect(listThreadTurns("a2", "t1")).toEqual([]);
    });

    test(`the registry keeps the newest ${ENDED_TURN_LIMIT} ended summaries and forgets the oldest`, () => {
        for (let i = 0; i <= ENDED_TURN_LIMIT; i++) {
            start(`k${i}`);
            endTurn(`k${i}`, { status: "done" }, T0);
        }
        expect(findTurn("k0")).toBeNull();
        expect(findTurn("k1")).not.toBeNull();
        expect(findTurn(`k${ENDED_TURN_LIMIT}`)).not.toBeNull();
    });

    test("a summary that a caller holds is a copy: a change to it does not reach the registry", () => {
        start("k1");
        // The turn started on the line above, thus the registry holds it.
        const held = findTurn("k1")!;
        held.status = "failed";
        expect(findTurn("k1")?.status).toBe("running");
    });
});

describe("the stop of the server", () => {
    test("each running turn aborts, and the count covers each analysis", () => {
        const a = start("k1", "t1", "a1");
        const b = start("k2", "t2", "a2");
        expect(runningTurnCount()).toBe(2);
        abortRunningTurns();
        expect([a.aborted, b.aborted]).toEqual([true, true]);
    });

    test("the idle wait settles at once with no turn, and at the end of the last turn otherwise", async () => {
        await whenNoRunningTurns();
        start("k1");
        start("k2");
        let settled = false;
        const idle = whenNoRunningTurns().then(() => {
            settled = true;
        });
        endTurn("k1", { status: "aborted", opened: true }, T0);
        await Promise.resolve();
        expect(settled).toBe(false);
        forgetTurn("k2");
        await idle;
        expect(settled).toBe(true);
    });

    test("the refusal of new turns holds until a test reset", () => {
        expect(newTurnsRefused()).toBe(false);
        refuseNewTurns();
        expect(newTurnsRefused()).toBe(true);
        __resetTurnsForTest();
        expect(newTurnsRefused()).toBe(false);
    });
});
