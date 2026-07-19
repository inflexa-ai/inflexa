import { afterEach, describe, expect, test } from "bun:test";

import { activeAsk, clearAsks, pushAsk, queuedCount, settleAsk } from "./asks.ts";
import { withRoot } from "../../test_support/solid.ts";

// The pending-asks store is a module singleton (one chat screen at a time), so clear it between cases.
afterEach(() => clearAsks());

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

    test("clearAsks empties the whole queue", () => {
        withRoot(() => {
            pushAsk({ askId: "a1", title: "t1", command: "c1" });
            pushAsk({ askId: "a2", title: "t2", command: "c2" });
            clearAsks();
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
