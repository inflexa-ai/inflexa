import { beforeEach, describe, expect, test } from "bun:test";

import type { ProfileParityOutcome } from "../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { asStr256 } from "../lib/types.ts";
import type { Analysis } from "../types/analysis.ts";
import type { StampedEvent } from "../types/events.ts";
import { __resetProfileQueueForTest, profileWorkInFlight, serializeProfileWork, watchInputDrift, type InputDriftOpts } from "./profile_queue.ts";

beforeEach(() => {
    __resetProfileQueueForTest();
});

/** A promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
}

describe("serializeProfileWork", () => {
    test("the drives of one analysis run one at a time; a second analysis does not wait", async () => {
        const order: string[] = [];
        const first = gate();
        const a1 = serializeProfileWork("a", async () => {
            order.push("a1:start");
            await first.promise;
            order.push("a1:end");
        });
        const a2 = serializeProfileWork("a", async () => {
            order.push("a2");
        });
        const b1 = serializeProfileWork("b", async () => {
            order.push("b1");
        });
        await b1;
        // The depth falls on the tail, one microtask after the work settles.
        await Promise.sleep(0);
        expect(order).toEqual(["a1:start", "b1"]);
        expect(profileWorkInFlight("a")).toBe(true);
        expect(profileWorkInFlight("b")).toBe(false);

        first.open();
        await Promise.all([a1, a2]);
        expect(order).toEqual(["a1:start", "b1", "a1:end", "a2"]);
        await Promise.sleep(0);
        expect(profileWorkInFlight("a")).toBe(false);
    });

    test("a rejected drive gives its rejection to its caller, and its successor still runs", async () => {
        const failed = serializeProfileWork("a", () => Promise.reject(new Error("staging failed")));
        let ran = false;
        const next = serializeProfileWork("a", async () => {
            ran = true;
        });
        expect(
            await failed.then(
                () => "ok",
                (cause: unknown) => (cause instanceof Error ? cause.message : "?"),
            ),
        ).toBe("staging failed");
        await next;
        expect(ran).toBe(true);
    });
});

describe("watchInputDrift", () => {
    const runtime = { tag: "runtime" } as unknown as HarnessRuntime;
    const analysisOf = (id: string): Analysis => ({ id, createdAt: 0, updatedAt: 0, name: asStr256(id), slug: id, anchorId: "anchor", projectId: null });

    /** A drift watch over a fake bus and a fake timer, with the reprofiles that it starts. */
    function harness(overrides: Partial<InputDriftOpts> = {}): {
        emit: (event: StampedEvent) => void;
        fire: () => void;
        armed: () => number;
        reprofiled: string[];
        stop: () => void;
    } {
        let handler: ((event: StampedEvent) => void) | null = null;
        const timers = new Set<() => void>();
        const reprofiled: string[] = [];
        const stop = watchInputDrift({
            runtime: () => runtime,
            analysis: (id) => analysisOf(id),
            reprofile: (_runtime, analysis): Promise<ProfileParityOutcome> => {
                reprofiled.push(analysis.id);
                return Promise.resolve({ kind: "triggered", restarted: true, materialized: true });
            },
            schedule: (fn) => {
                timers.add(fn);
                return () => timers.delete(fn);
            },
            subscribe: (h) => {
                handler = h;
                return () => {
                    handler = null;
                };
            },
            ...overrides,
        });
        return {
            emit: (event) => handler?.(event),
            fire: () => {
                const due = [...timers];
                timers.clear();
                for (const fn of due) fn();
            },
            armed: () => timers.size,
            reprofiled,
            stop,
        };
    }

    // The field of a stamped event that the watch does not read.
    const stamp = { __infId: "test" } as const;
    const added = (analysisId: string): StampedEvent => ({ ...stamp, type: "prov.input_added", analysisId }) as unknown as StampedEvent;
    const removed = (analysisId: string): StampedEvent => ({ ...stamp, type: "prov.input_removed", analysisId }) as unknown as StampedEvent;

    test("a burst of input events gives one re-profile for each analysis", async () => {
        const h = harness();
        h.emit(added("a"));
        h.emit(removed("a"));
        h.emit(added("b"));
        h.emit({ ...stamp, type: "prov.analysis_created", analysisId: "a" } as unknown as StampedEvent);
        expect(h.armed()).toBe(2);
        h.fire();
        await Promise.sleep(0);
        expect(h.reprofiled.sort()).toEqual(["a", "b"]);
    });

    test("no re-profile while the runtime is not ready, or for an analysis that is gone", async () => {
        const noRuntime = harness({ runtime: () => null });
        noRuntime.emit(added("a"));
        noRuntime.fire();
        const gone = harness({ analysis: () => null });
        gone.emit(added("a"));
        gone.fire();
        await Promise.sleep(0);
        expect(noRuntime.reprofiled).toEqual([]);
        expect(gone.reprofiled).toEqual([]);
    });

    test("the unsubscribe cancels the armed timers and ignores later events", () => {
        const h = harness();
        h.emit(added("a"));
        h.stop();
        expect(h.armed()).toBe(0);
        h.emit(added("a"));
        expect(h.armed()).toBe(0);
    });
});
