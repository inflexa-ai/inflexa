import { describe, expect, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import type { ServerBootError, ServerState } from "../api/server.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import { createServerBoot, type ServerBootOpts } from "./boot.ts";

const STARTED_AT = new Date("2026-10-02T08:00:00.000Z");

// The boot holder reads only the connection identity and the conversation model of the handle, thus a
// stand-in with those two fields is sound for these offline tests.
function fakeRuntime(model: string): HarnessRuntime {
    return { conversation: { model }, connection: { provider: "anthropic", mode: "cliproxy" } } as unknown as HarnessRuntime;
}

/** How a test settles the boot: the runtime, or the boot error. */
type Outcome = { runtime: HarnessRuntime } | { bootError: ServerBootError };

/** Boot opts whose boot waits for the test to settle it, and a log of the calls of each reaction. */
function controlled(): {
    opts: ServerBootOpts;
    settle: (outcome: Outcome) => void;
    reject: (cause: unknown) => void;
    boots: () => number;
    readies: HarnessRuntime[];
    settled: ServerState[];
} {
    let boots = 0;
    let settle: (outcome: Outcome) => void = () => undefined;
    let reject: (cause: unknown) => void = () => undefined;
    const readies: HarnessRuntime[] = [];
    const settled: ServerState[] = [];
    return {
        opts: {
            boot: () => {
                boots += 1;
                // `ok`/`err` stay in return position, where the must-use rule sees the Result consumed.
                return new Promise<Outcome>((resolve, fail) => {
                    settle = resolve;
                    reject = fail;
                }).then((outcome): Result<HarnessRuntime, ServerBootError> => ("runtime" in outcome ? ok(outcome.runtime) : err(outcome.bootError)));
            },
            onReady: (runtime) => readies.push(runtime),
            onSettle: (state) => settled.push(state),
        },
        settle: (outcome) => settle(outcome),
        reject: (cause) => reject(cause),
        boots: () => boots,
        readies,
        settled,
    };
}

describe("createServerBoot", () => {
    test("is `starting` with no runtime before the boot settles", () => {
        const boot = createServerBoot(STARTED_AT, controlled().opts);
        expect(boot.state()).toEqual({ version: expect.any(String), apiVersion: 1, startedAt: STARTED_AT.toISOString(), phase: "starting" });
        expect(boot.runtime()).toBeNull();
    });

    test("a successful boot is `ready` with the connection and the model, and runs the ready work one time", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const attempt = boot.start();
        const runtime = fakeRuntime("claude-test");
        c.settle({ runtime });
        await attempt;

        expect(boot.state()).toMatchObject({ phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model: "claude-test" } });
        expect(boot.runtime()).toBe(runtime);
        expect(c.readies).toEqual([runtime]);
        expect(c.settled.map((s) => s.phase)).toEqual(["ready"]);
    });

    test("a failed boot is `failed` with its error, and a new start boots again", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const first = boot.start();
        const bootError: ServerBootError = { reason: "postgres_unavailable", message: "start Postgres", detailLines: ["ECONNREFUSED"] };
        c.settle({ bootError });
        await first;
        expect(boot.state()).toMatchObject({ phase: "failed", bootError });
        expect(boot.runtime()).toBeNull();

        const second = boot.start();
        expect(boot.state().phase).toBe("starting");
        c.settle({ runtime: fakeRuntime("claude-retry") });
        await second;
        expect(boot.state().phase).toBe("ready");
        expect(c.boots()).toBe(2);
    });

    test("a start while a boot runs joins it, and a start after `ready` does nothing", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const first = boot.start();
        const joined = boot.start();
        expect(joined).toBe(first);
        c.settle({ runtime: fakeRuntime("claude-test") });
        await first;

        await boot.start();
        expect(c.boots()).toBe(1);
        expect(c.readies).toHaveLength(1);
    });

    test("a boot that rejects past its Result is `failed`, never stuck in `starting`", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const attempt = boot.start();
        c.reject(new Error("the proxy gate threw"));
        await attempt;
        const state = boot.state();
        expect(state.phase).toBe("failed");
        if (state.phase === "failed") {
            expect(state.bootError.reason).toBe("runtime_boot_failed");
            expect(state.bootError.message).toContain("the proxy gate threw");
        }
    });
});
