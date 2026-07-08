import { afterEach, describe, expect, test } from "bun:test";
import { ok, err } from "neverthrow";

import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime, HarnessBootError } from "../../modules/harness/runtime.ts";
import { describeBootError } from "../../modules/harness/profile.ts";
import { bootState, harnessRuntime, startHarnessBoot, __resetBootForTest, type BootDriver } from "./boot.ts";

afterEach(() => __resetBootForTest());

// The injected driver ignores its argument (these tests never touch a real boot), so only the type of
// the config matters — an empty stand-in cast keeps the transition tests offline.
const cfg = {} as ResolvedHarnessConfig;

// The store reads only `.model` off the handle; the rest of HarnessRuntime is infrastructure the
// transition tests never exercise, so a partial stand-in cast is sound and keeps the test offline.
function fakeRuntime(model: string): HarnessRuntime {
    return { model } as unknown as HarnessRuntime;
}

// Drivers keep `ok`/`err` in RETURN position (the neverthrow must-use rule flags a Result passed as an
// argument, not one returned) — the caller, startHarnessBoot, is what consumes it via `.match`.
const readyDriver =
    (model: string): BootDriver =>
    async () =>
        ok(fakeRuntime(model));
const failDriver =
    (e: HarnessBootError): BootDriver =>
    async () =>
        err(e);

describe("boot store transitions", () => {
    test("starts idle with no handle", () => {
        expect(bootState().phase).toBe("idle");
        expect(harnessRuntime()).toBeNull();
    });

    test("booting is published synchronously, then ready stashes the handle + model", async () => {
        const pending = startHarnessBoot(cfg, readyDriver("claude-test"));
        // startHarnessBoot sets `booting` before its first await, so the transition is observable
        // without awaiting the driver — this is what the status bar / animation mount on.
        expect(bootState().phase).toBe("booting");

        await pending;
        const settled = bootState();
        expect(settled.phase).toBe("ready");
        if (settled.phase === "ready") expect(settled.model).toBe("claude-test");
        expect(harnessRuntime()?.model).toBe("claude-test");
    });

    test("a boot failure publishes the actionable describeBootError message, no handle", async () => {
        const e: HarnessBootError = { type: "runtime_already_active", holderPid: 4821 };
        await startHarnessBoot(cfg, failDriver(e));

        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") {
            expect(settled.message).toBe(describeBootError(e));
            expect(settled.message).toContain("4821"); // the taxonomy's actionable detail survived
        }
        expect(harnessRuntime()).toBeNull();
    });

    test("a second call while booting is a no-op (the second driver never runs)", async () => {
        let firstCalls = 0;
        let secondCalls = 0;
        // A gate the test opens to release the first driver, so the first boot stays in flight (phase
        // `booting`) while the second call is made — resolves a `Promise<void>`, so no Result is passed.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const firstDriver: BootDriver = async () => {
            firstCalls += 1;
            await gate;
            return ok(fakeRuntime("claude-first"));
        };
        const secondDriver: BootDriver = async () => {
            secondCalls += 1;
            return ok(fakeRuntime("should-not-happen"));
        };

        const pending = startHarnessBoot(cfg, firstDriver);
        expect(bootState().phase).toBe("booting");

        await startHarnessBoot(cfg, secondDriver); // no-op: already booting
        expect(secondCalls).toBe(0);
        expect(firstCalls).toBe(1);

        release();
        await pending;
        const settled = bootState();
        expect(settled.phase).toBe("ready");
        if (settled.phase === "ready") expect(settled.model).toBe("claude-first");
    });

    test("a second call while ready is a no-op (the ready model + handle are unchanged)", async () => {
        await startHarnessBoot(cfg, readyDriver("claude-a"));
        expect(bootState().phase).toBe("ready");

        let called = 0;
        const rebootDriver: BootDriver = async () => {
            called += 1;
            return ok(fakeRuntime("claude-b"));
        };
        await startHarnessBoot(cfg, rebootDriver);
        expect(called).toBe(0);

        const settled = bootState();
        if (settled.phase === "ready") expect(settled.model).toBe("claude-a");
        expect(harnessRuntime()?.model).toBe("claude-a");
    });
});
