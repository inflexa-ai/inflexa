import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync, ResultAsync } from "neverthrow";

import type { AskList } from "../../../api/conversation.ts";
import { activeAsk, clearTurnAsks, pushAsk, queuedCount, refreshPolledAsks, settleAsk, syncPolledAsks } from "../asks.ts";
import { withRoot } from "../../../test_support/solid.ts";

// The pending-asks store is a module singleton (one chat screen at a time), so clear it between cases.
afterEach(() => {
    clearTurnAsks();
    syncPolledAsks("", []);
});

describe("pending-asks store", () => {
    test("pushAsk enqueues at the tail; activeAsk is the head; queuedCount counts the rest", () => {
        withRoot(() => {
            expect(activeAsk()).toBeNull();
            expect(queuedCount()).toBe(0);
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            pushAsk({ askId: "a2", title: "t2", command: "c2" });
            expect(activeAsk()?.askId).toBe("a1");
            expect(queuedCount()).toBe(1);
        });
    });

    test("settleAsk removes by id and advances the head FIFO", () => {
        withRoot(() => {
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            pushAsk({ askId: "a2", title: "t2", command: "c2" });
            settleAsk("a1");
            expect(activeAsk()?.askId).toBe("a2");
            expect(queuedCount()).toBe(0);
        });
    });

    test("settleAsk on an unknown id is a no-op — a stale answer never wedges the queue", () => {
        withRoot(() => {
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            settleAsk("gone");
            expect(activeAsk()?.askId).toBe("a1");
            expect(queuedCount()).toBe(0);
        });
    });

    test("settleAsk can drain out of order, then empties the queue", () => {
        withRoot(() => {
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            pushAsk({ askId: "a2", title: "t2", command: "c2" });
            settleAsk("a2");
            expect(activeAsk()?.askId).toBe("a1");
            settleAsk("a1");
            expect(activeAsk()).toBeNull();
            expect(queuedCount()).toBe(0);
        });
    });

    test("clearTurnAsks empties a queue that holds only asks of the turn", () => {
        withRoot(() => {
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            pushAsk({ askId: "a2", title: "t2", command: "c2" });
            clearTurnAsks();
            expect(activeAsk()).toBeNull();
            expect(queuedCount()).toBe(0);
        });
    });

    test("copy-on-receive: mutating the pushed object after push does not corrupt the stored head", () => {
        withRoot(() => {
            const ask = { askId: "a1", title: "orig", command: "c1", detail: "d" };
            pushAsk(ask);
            ask.title = "MUTATED";
            ask.detail = "MUTATED";
            expect(activeAsk()?.title).toBe("orig");
            expect(activeAsk()?.detail).toBe("d");
        });
    });
});

/** The ids in the queue, head first. */
function queuedIds(): string[] {
    const ids: string[] = [];
    while (activeAsk() !== null) {
        const id = activeAsk()?.askId ?? "";
        ids.push(id);
        settleAsk(id);
    }
    return ids;
}

describe("the asks that the poll docks", () => {
    test("each listed ask that the queue does not hold docks after the asks already there", () => {
        withRoot(() => {
            pushAsk({ askId: "turn-1", title: "t", command: "c" });
            syncPolledAsks("A", [
                { askId: "turn-1", title: "t", command: "c" },
                { askId: "step-1", title: "Download", command: "https://example.org/a.gtf" },
            ]);
            expect(queuedIds()).toEqual(["turn-1", "step-1"]);
        });
    });

    test("turn teardown keeps the ask of a step and removes the ask of the turn", () => {
        withRoot(() => {
            syncPolledAsks("A", [{ askId: "step-1", title: "t", command: "c" }]);
            pushAsk({ askId: "turn-1", title: "t", command: "c" });
            clearTurnAsks();
            expect(queuedIds()).toEqual(["step-1"]);
        });
    });

    test("an ask that the poll docked first and a turn then pushes belongs to the turn", () => {
        withRoot(() => {
            syncPolledAsks("A", [{ askId: "a1", title: "t", command: "c" }]);
            pushAsk({ askId: "a1", title: "t", command: "c" });
            expect(queuedCount()).toBe(0);
            clearTurnAsks();
            expect(activeAsk()).toBeNull();
        });
    });

    test("an ask of a step leaves when the poll no longer lists it, and an ask of a turn stays", () => {
        withRoot(() => {
            pushAsk({ askId: "turn-1", title: "t", command: "c" });
            syncPolledAsks("A", [{ askId: "step-1", title: "t", command: "c" }]);
            syncPolledAsks("A", []);
            expect(queuedIds()).toEqual(["turn-1"]);
        });
    });

    test("the poll of a different analysis removes the asks that the poll docked for the first one", () => {
        withRoot(() => {
            syncPolledAsks("A", [{ askId: "step-a", title: "t", command: "c" }]);
            syncPolledAsks("B", [{ askId: "step-b", title: "t", command: "c" }]);
            expect(queuedIds()).toEqual(["step-b"]);
        });
    });
});

describe("refreshPolledAsks", () => {
    function listOf(...ids: string[]): AskList {
        return {
            asks: ids.map((id) => ({
                id,
                analysisId: "A",
                userId: "u",
                threadId: null,
                runId: null,
                stepId: null,
                title: `title ${id}`,
                command: `command ${id}`,
                detail: null,
                createdAt: "2026-11-23T00:00:00.000Z",
            })),
            page: 0,
            perPage: 200,
            total: ids.length,
            hasMore: false,
        };
    }

    test("a read docks the pending asks of the analysis, with no detail for a null detail", async () => {
        await refreshPolledAsks("A", { fetch: () => okAsync(listOf("step-1")) });
        expect(activeAsk()).toMatchObject({ askId: "step-1", title: "title step-1", command: "command step-1", detail: undefined });
    });

    test("a failed read changes nothing", async () => {
        await refreshPolledAsks("A", { fetch: () => okAsync(listOf("step-1")) });
        await refreshPolledAsks("A", { fetch: () => errAsync({ type: "aborted" as const }) });
        expect(activeAsk()?.askId).toBe("step-1");
    });

    test("a slow read that a newer read superseded docks nothing", async () => {
        let release: (list: AskList) => void = () => {};
        const slow = refreshPolledAsks("A", { fetch: () => ResultAsync.fromSafePromise(new Promise<AskList>((resolve) => (release = resolve))) });
        await refreshPolledAsks("B", { fetch: () => okAsync(listOf()) });
        release(listOf("old"));
        await slow;
        expect(activeAsk()).toBeNull();
    });
});
