import { describe, expect, test } from "bun:test";

import { createServerLifecycle, type ServerLifecycleOpts } from "./lifecycle.ts";

/**
 * A turn registry in memory, a clock that the test advances, and an exit that records. Each event of the stop
 * goes to `events` in its order.
 */
function harness(runningTurns: number): {
    opts: ServerLifecycleOpts;
    events: string[];
    endTurns: () => void;
    elapse: (ms: number) => void;
    exited: Promise<void>;
} {
    const events: string[] = [];
    let running = runningTurns;
    let idle: (() => void)[] = [];
    let timers: { at: number; fire: () => void }[] = [];
    let now = 0;
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
        markExited = resolve;
    });
    const endTurns = (): void => {
        running = 0;
        for (const release of idle.splice(0)) release();
    };
    return {
        events,
        exited,
        endTurns,
        elapse: (ms) => {
            now += ms;
            const due = timers.filter((timer) => timer.at <= now);
            timers = timers.filter((timer) => timer.at > now);
            for (const timer of due) timer.fire();
        },
        opts: {
            drainLimitMs: 60_000,
            abortGraceMs: 5_000,
            refuseNewTurns: () => events.push("refuse"),
            runningTurnCount: () => running,
            abortRunningTurns: () => {
                events.push(`abort ${running}`);
            },
            whenNoRunningTurns: () => (running === 0 ? Promise.resolve() : new Promise<void>((resolve) => idle.push(resolve))),
            sleep: (ms) => new Promise<void>((resolve) => timers.push({ at: now + ms, fire: resolve })),
            exit: () => {
                events.push("exit");
                markExited();
                idle = [];
                return Promise.resolve();
            },
        },
    };
}

/** Let each settled promise run its continuation. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("the stop of the server", () => {
    test("`now` refuses new turns, aborts each running turn at once, and exits after they unwind", async () => {
        const h = harness(2);
        const lifecycle = createServerLifecycle(h.opts);
        expect(lifecycle.requestShutdown("now")).toEqual({ mode: "now", activeTurns: 2 });
        expect(lifecycle.stopping()).toBe("now");
        await settle();
        expect(h.events).toEqual(["refuse", "abort 2"]);
        h.endTurns();
        await h.exited;
        expect(h.events).toEqual(["refuse", "abort 2", "exit"]);
    });

    test("`drain` waits for the running turns, and aborts none when they end in time", async () => {
        const h = harness(1);
        const lifecycle = createServerLifecycle(h.opts);
        expect(lifecycle.requestShutdown("drain")).toEqual({ mode: "drain", activeTurns: 1 });
        h.elapse(59_000);
        await settle();
        expect(h.events).toEqual(["refuse"]);
        h.endTurns();
        await h.exited;
        expect(h.events).toEqual(["refuse", "abort 0", "exit"]);
    });

    test("`drain` aborts the turns that still run at the limit, then exits after the grace when they do not unwind", async () => {
        const h = harness(1);
        createServerLifecycle(h.opts).requestShutdown("drain");
        h.elapse(60_000);
        await settle();
        expect(h.events).toEqual(["refuse", "abort 1"]);
        h.elapse(5_000);
        await h.exited;
        expect(h.events).toEqual(["refuse", "abort 1", "exit"]);
    });

    test("with no running turn, either mode exits at once", async () => {
        for (const mode of ["now", "drain"] as const) {
            const h = harness(0);
            createServerLifecycle(h.opts).requestShutdown(mode);
            await h.exited;
            expect(h.events).toEqual(["refuse", "abort 0", "exit"]);
        }
    });

    test("a second request starts no second stop, and gives the mode of the first", async () => {
        const h = harness(1);
        const lifecycle = createServerLifecycle(h.opts);
        lifecycle.requestShutdown("drain");
        expect(lifecycle.requestShutdown("now")).toEqual({ mode: "drain", activeTurns: 1 });
        expect(lifecycle.stopping()).toBe("drain");
        h.endTurns();
        await h.exited;
        expect(h.events.filter((event) => event === "refuse" || event === "exit")).toEqual(["refuse", "exit"]);
    });

    test("a server that runs is not stopping", () => {
        expect(createServerLifecycle(harness(0).opts).stopping()).toBeNull();
    });
});
