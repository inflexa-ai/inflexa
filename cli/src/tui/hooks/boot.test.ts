import { afterEach, describe, expect, test } from "bun:test";
import { ok, err } from "neverthrow";
import { createRoot } from "solid-js";
import type { ChatProvider } from "@inflexa-ai/harness";

import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import type { HarnessRuntime, HarnessBootError } from "../../modules/harness/runtime.ts";
import { describeBootError } from "../../modules/harness/profile.ts";
import {
    __resetGaugeForTest,
    clearAgentSwitch,
    createSwappableProvider,
    enterChatTurn,
    installAgentSwitch,
    requestAgentModelChange,
} from "../../modules/harness/agent_switch.ts";
import { bootState, harnessRuntime, agentModels, startHarnessBoot, watchAgentModels, __resetBootForTest, type BootDriver } from "./boot.ts";

afterEach(() => __resetBootForTest());

// The injected driver ignores its argument (these tests never touch a real boot), so only the type of
// the config matters — an empty stand-in cast keeps the transition tests offline.
const cfg = {} as ResolvedHarnessConfig;

// The store reads the CONVERSATION agent's `.model` and the `.connection` identity off the handle; the
// rest of HarnessRuntime is infrastructure the transition tests never exercise, so a partial stand-in
// cast is sound and offline.
function fakeRuntime(model: string): HarnessRuntime {
    return { conversation: { model }, connection: { provider: "anthropic", mode: "cliproxy" } } as unknown as HarnessRuntime;
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
        expect(harnessRuntime()?.conversation.model).toBe("claude-test");
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
        expect(harnessRuntime()?.conversation.model).toBe("claude-a");
    });
});

// The agent-models store mirrors the live agent switch. These drive the REAL
// switch (agent_switch.ts) over a fake wiring and assert the reactive cell tracks it: seeded at the ready
// edge, updated on an idle swap, and showing a scheduled switch as pending until it lands.
describe("agent-models store (watchAgentModels)", () => {
    afterEach(() => {
        clearAgentSwitch();
        __resetGaugeForTest();
    });

    // A structurally-minimal provider: the switch only swaps handles, never calls the wire, so `chat`/
    // `chatStream` are never reached and the double cast is honest (mirrors agent_switch.test.ts).
    function fakeProvider(): ChatProvider {
        return {
            capabilities: { toolCalling: true },
            chat: () => {
                throw new Error("unused in the agent-models store test");
            },
            chatStream: () => {
                throw new Error("unused in the agent-models store test");
            },
        } as unknown as ChatProvider;
    }

    function installFakeSwitch(models: { conversation: string; sandbox: string }): void {
        installAgentSwitch({
            swappable: { conversation: createSwappableProvider(fakeProvider()), sandbox: createSwappableProvider(fakeProvider()) },
            rebuildProvider: () => fakeProvider(),
            swapSandboxEmitters: () => {},
            modelProvider: "anthropic",
            initialModels: models,
        });
    }

    test("stays empty before ready, then seeds both agents' current models at the ready edge", async () => {
        installFakeSwitch({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" });
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels();
        });
        try {
            expect(agentModels().current).toEqual({ conversation: "", sandbox: "" });
            await startHarnessBoot(cfg, readyDriver("claude-opus-4-8"));
            expect(agentModels().current).toEqual({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" });
        } finally {
            dispose();
        }
    });

    test("an idle swap updates the store; a switch scheduled behind work shows as pending, then clears when it lands", async () => {
        installFakeSwitch({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5" });
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels();
        });
        try {
            await startHarnessBoot(cfg, readyDriver("claude-opus-4-8"));

            // Idle → the sandbox swap applies immediately and the store follows.
            requestAgentModelChange("sandbox", "claude-haiku-4-5");
            expect(agentModels().current.sandbox).toBe("claude-haiku-4-5");
            expect(agentModels().pending.size).toBe(0);

            // Busy (a chat turn) → the chat switch schedules and shows pending without changing current.
            const leaveTurn = enterChatTurn();
            requestAgentModelChange("conversation", "claude-sonnet-4-5");
            expect(agentModels().pending.get("conversation")).toBe("claude-sonnet-4-5");
            expect(agentModels().current.conversation).toBe("claude-opus-4-8");

            // The turn settles → the pending switch lands and clears.
            leaveTurn();
            expect(agentModels().current.conversation).toBe("claude-sonnet-4-5");
            expect(agentModels().pending.size).toBe(0);
        } finally {
            dispose();
        }
    });
});
