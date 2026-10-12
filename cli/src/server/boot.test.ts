import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { err, ok, type Result } from "neverthrow";

import type { ServerBootError, ServerBootState } from "../api/server.ts";
import * as harnessConfig from "../modules/harness/config.ts";
import * as harnessRuntime from "../modules/harness/runtime.ts";
import type { HarnessRuntime } from "../modules/harness/runtime.ts";
import * as setup from "../modules/infra/setup.ts";
import { createServerBoot, DEFAULT_SERVER_BOOT_OPTS, type BootProgressOpts, type ServerBootOpts } from "./boot.ts";

const STARTED_AT = new Date("2026-10-02T08:00:00.000Z");

// The boot holder reads only the connection identity and the conversation model of the handle, thus a
// stand-in with those two fields is sound for these offline tests.
function fakeRuntime(model: string): HarnessRuntime {
    return { conversation: { model }, connection: { provider: "anthropic", mode: "cliproxy" } } as unknown as HarnessRuntime;
}

/** How a test settles the boot: the runtime, or the boot error. */
type Outcome = { runtime: HarnessRuntime } | { bootError: ServerBootError };

/** The ISO time of the test clock, `seconds` after the start of the server. */
function at(seconds: number): string {
    return new Date(STARTED_AT.getTime() + seconds * 1000).toISOString();
}

/**
 * Boot opts whose boot waits for the test to settle it, a log of the calls of each reaction, and a clock that the
 * test moves. `attempts` holds the callbacks that the holder gave to each attempt, in order.
 */
function controlled(): {
    opts: ServerBootOpts;
    attempts: BootProgressOpts[];
    advance: (seconds: number) => void;
    settle: (outcome: Outcome) => void;
    reject: (cause: unknown) => void;
    boots: () => number;
    readies: HarnessRuntime[];
    settled: ServerBootState[];
} {
    let boots = 0;
    let clock = STARTED_AT.getTime();
    const attempts: BootProgressOpts[] = [];
    let settle: (outcome: Outcome) => void = () => undefined;
    let reject: (cause: unknown) => void = () => undefined;
    const readies: HarnessRuntime[] = [];
    const settled: ServerBootState[] = [];
    return {
        opts: {
            boot: (progress) => {
                boots += 1;
                attempts.push(progress);
                // `ok`/`err` stay in return position, where the must-use rule sees the Result consumed.
                return new Promise<Outcome>((resolve, fail) => {
                    settle = resolve;
                    reject = fail;
                }).then((outcome): Result<HarnessRuntime, ServerBootError> => ("runtime" in outcome ? ok(outcome.runtime) : err(outcome.bootError)));
            },
            now: () => new Date(clock),
            onReady: (runtime) => readies.push(runtime),
            onSettle: (state) => settled.push(state),
        },
        attempts,
        advance: (seconds) => {
            clock += seconds * 1000;
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
        expect(boot.state()).toEqual({
            version: expect.any(String),
            apiVersion: 1,
            startedAt: STARTED_AT.toISOString(),
            phase: "starting",
            boot: { attemptStartedAt: STARTED_AT.toISOString(), step: null, done: [] },
        });
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

    test("a step moves to `done` with its start time and its end time when the next step starts", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        void boot.start();
        const progress = c.attempts[0]!;

        c.advance(1);
        progress.onStep("container_engine");
        expect(boot.state()).toMatchObject({
            phase: "starting",
            boot: { attemptStartedAt: at(0), step: { id: "container_engine", startedAt: at(1) }, done: [] },
        });

        c.advance(2);
        progress.onStep("images");
        expect(boot.state()).toMatchObject({
            boot: { step: { id: "images", startedAt: at(3) }, done: [{ id: "container_engine", startedAt: at(1), endedAt: at(3) }] },
        });

        c.advance(4);
        progress.onStep("containers");
        expect(boot.state()).toMatchObject({
            boot: {
                step: { id: "containers", startedAt: at(7) },
                done: [
                    { id: "container_engine", startedAt: at(1), endedAt: at(3) },
                    { id: "images", startedAt: at(3), endedAt: at(7) },
                ],
            },
        });
    });

    test("the progress shows only on the `images` step and goes with the step", () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        void boot.start();
        const progress = c.attempts[0]!;

        progress.onPullProgress({ doneBytes: 1, totalBytes: 2 });
        progress.onStep("proxy");
        progress.onPullProgress({ doneBytes: 1, totalBytes: 2 });
        expect(boot.state()).toMatchObject({ boot: { step: { id: "proxy" } } });
        expect(boot.state()).not.toHaveProperty("boot.step.progress");

        progress.onStep("images");
        expect(boot.state()).not.toHaveProperty("boot.step.progress");
        progress.onPullProgress({ doneBytes: 40, totalBytes: 120 });
        expect(boot.state()).toMatchObject({ boot: { step: { id: "images", progress: { doneBytes: 40, totalBytes: 120 } } } });

        progress.onStep("containers");
        expect(boot.state()).not.toHaveProperty("boot.step.progress");
        expect(boot.state()).toMatchObject({ boot: { done: [{ id: "proxy" }, { id: "images" }] } });
    });

    test("a boot error gives the times of the attempt and the step that ran", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const attempt = boot.start();
        const progress = c.attempts[0]!;
        c.advance(1);
        progress.onStep("containers");
        c.advance(5);
        const bootError: ServerBootError = { reason: "infra_unready", message: "start Postgres", detailLines: [] };
        c.settle({ bootError });
        await attempt;

        expect(boot.state()).toMatchObject({ phase: "failed", bootError, attemptStartedAt: at(0), failedAt: at(6), failedStep: "containers" });
        expect(c.settled.at(-1)).toMatchObject({ phase: "failed", failedStep: "containers" });
    });

    test("a boot that throws gives the same failed fields", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const attempt = boot.start();
        c.advance(1);
        c.attempts[0]!.onStep("embedder");
        c.advance(2);
        c.reject(new Error("the embedder gate threw"));
        await attempt;

        expect(boot.state()).toMatchObject({ phase: "failed", attemptStartedAt: at(0), failedAt: at(3), failedStep: "embedder" });
    });

    test("a fault before the first step has `failedStep` null", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const attempt = boot.start();
        c.settle({ bootError: { reason: "model_connection_invalid", message: "the model connection is not valid", detailLines: [] } });
        await attempt;

        expect(boot.state()).toMatchObject({ phase: "failed", failedStep: null });
    });

    test("a new attempt starts with an empty `done` list and a new start time", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const first = boot.start();
        c.attempts[0]!.onStep("container_engine");
        c.attempts[0]!.onStep("images");
        c.settle({ bootError: { reason: "infra_unready", message: "pull", detailLines: [] } });
        await first;

        c.advance(30);
        void boot.start();

        expect(boot.state()).toMatchObject({ phase: "starting", boot: { attemptStartedAt: at(30), step: null, done: [] } });
    });

    test("a callback that runs after its attempt settled changes nothing", async () => {
        const c = controlled();
        const boot = createServerBoot(STARTED_AT, c.opts);
        const first = boot.start();
        c.attempts[0]!.onStep("images");
        c.settle({ bootError: { reason: "infra_unready", message: "pull", detailLines: [] } });
        await first;
        const failed = boot.state();

        c.attempts[0]!.onStep("containers");
        c.attempts[0]!.onPullProgress({ doneBytes: 9, totalBytes: 9 });
        expect(boot.state()).toEqual(failed);

        // A late call of the old attempt does not touch the next attempt either.
        void boot.start();
        c.attempts[0]!.onStep("runtime");
        expect(boot.state()).toMatchObject({ phase: "starting", boot: { step: null, done: [] } });
    });
});

describe("the production boot", () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    test("gives its callbacks to the proxy gate, and starts the `runtime` step after the gate and before the harness config", async () => {
        const calls: string[] = [];
        const given: Array<Parameters<typeof setup.ensureProxyReady>[1]> = [];
        // Taken before the spy, so the stub can call through and the config stays the real, valid one.
        const realConnection = harnessConfig.resolveModelConnection;
        const realConfig = harnessConfig.resolveHarnessConfig;
        spies.push(
            spyOn(harnessConfig, "resolveModelConnection").mockImplementation(() => ({ ...realConnection(), mode: "cliproxy", configError: undefined })),
            spyOn(setup, "ensureProxyReady").mockImplementation(async (_mode, opts) => {
                calls.push("ensureProxyReady");
                given.push(opts);
                return ok(undefined);
            }),
            spyOn(harnessConfig, "resolveHarnessConfig").mockImplementation(() => {
                calls.push("resolveHarnessConfig");
                return realConfig();
            }),
            spyOn(harnessRuntime, "bootHarnessRuntime").mockImplementation(async () => {
                calls.push("bootHarnessRuntime");
                return err({ type: "harness_config_invalid", issues: "stub: stop the boot before a runtime exists" });
            }),
        );
        const progress: BootProgressOpts = {
            onStep: (id) => calls.push(`step:${id}`),
            onPullProgress: () => undefined,
        };

        const result = await DEFAULT_SERVER_BOOT_OPTS.boot(progress);

        expect(result.isErr()).toBe(true);
        expect(given[0]?.onStep).toBe(progress.onStep);
        expect(given[0]?.onPullProgress).toBe(progress.onPullProgress);
        expect(given[0]?.interactiveLogin).toBe(false);
        expect(calls).toEqual(["ensureProxyReady", "step:runtime", "resolveHarnessConfig", "bootHarnessRuntime"]);
    });
});
