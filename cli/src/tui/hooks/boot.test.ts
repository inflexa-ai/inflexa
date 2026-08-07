import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, okAsync, err } from "neverthrow";
import { createRoot } from "solid-js";
import { createCitationResolver, type ChatProvider } from "@inflexa-ai/harness";

import { runtimes } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import { bootHarnessRuntime, __resetHarnessRuntimeForTest, type HarnessRuntime, type HarnessBootError } from "../../modules/harness/runtime.ts";
import { describeBootError } from "../../modules/harness/profile.ts";
import { turnSubmitAction } from "../app.tsx";
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

// The regression the detached-download change exists to prevent. `runtime.test.ts` proves that the boot
// returns a runtime when the store inventory resolves to null, and nothing followed that chain onward.
// Here the REAL boot drives the store: the phase must reach `ready`, because `App` hands exactly that
// predicate to `turnSubmitAction` as its `ready` input, and a submit is silently dropped while it is
// false. A store refusal that creeps back into the boot shows up here as a chat that answers nothing.
describe("a boot on a machine with no package store", () => {
    let skillsDir: string;
    let templatesDir: string;

    beforeEach(() => {
        // A boot in a different file leaves a process singleton that `bootHarnessRuntime` serves without
        // running anything. Drop it first, thus this test always drives the real sequence.
        __resetHarnessRuntimeForTest();
        // A successful boot takes the machine-wide runtime lock, which writes a real file under
        // `env.locksDir`. The guard keeps that write inside the test sandbox.
        assertTestSandbox(env.locksDir);
        skillsDir = mkdtempSync(join(tmpdir(), "boot-store-free-skills-"));
        templatesDir = mkdtempSync(join(tmpdir(), "boot-store-free-templates-"));
    });

    afterEach(() => {
        // Drop the process singleton and the agent switch the boot installed, so this runtime never
        // answers a later boot.
        __resetHarnessRuntimeForTest();
        rmSync(skillsDir, { recursive: true, force: true });
        rmSync(templatesDir, { recursive: true, force: true });
    });

    function storeFreeConfig(): ResolvedHarnessConfig {
        return {
            model: "claude-test-model",
            bioKeys: { drugbank: "", disgenet: "", epaCcte: "" },
            sandboxImage: "ghcr.io/inflexa-ai/sandbox-base:latest",
            resourcePolicy: { perStep: { maxCpu: 1, maxMemoryGb: 1, maxGpuCount: 0 }, budget: { cpu: 1, memoryGb: 1 } },
            adminPort: 8433,
            skillsDir,
            templatesDir,
        };
    }

    /**
     * The real boot sequence over offline seams, with the one seam under test giving `null` — the answer
     * `storePackagesFile` gives when the active farm carries no `packages.txt`, and the answer a machine
     * whose catalog is still downloading gives. Every seam that would reach a container engine, Postgres,
     * the proxy, or DBOS is stubbed, thus the sequence between them is the production one.
     */
    const storeFreeDriver: BootDriver = (options) =>
        bootHarnessRuntime({
            ...options,
            connection: { mode: "cliproxy", provider: "anthropic", agents: {} },
            seams: {
                resolveStorePackages: () => null,
                resolveSandboxEngine: async () => ok({ runtime: runtimes.docker, socketPath: undefined }),
                ensurePostgres: async () => ok({ host: "localhost", port: 5, database: "d", user: "u", password: "p" }),
                readKey: async () => ok("proxy-key"),
                resolveModel: async () => ok("claude-from-proxy"),
                resolveEmbedding: () => ok({ dimensions: 1536, embed: (texts) => okAsync(texts.map(() => new Array(1536).fill(0))) }),
                probeEmbedding: async () => ok(undefined),
                // The harness owns the boot tail, and `runtime.test.ts` pins its order against the real
                // deps. This stand-in returns the handle shape only, and it runs no `beforeLaunch` hook:
                // the store decision is made BEFORE this call, so nothing after it belongs to this test.
                boot: async () => ({
                    runtime: {
                        agents: {
                            forThread: () => ok({ id: "conversation-agent", systemPrompt: "", model: "claude-test-model", tools: [], maxIterations: 50 }),
                        },
                        workflows: {
                            executeAnalysis: async () => ({
                                runId: "",
                                workflowId: "",
                                status: "completed",
                                completedSteps: [],
                                failedSteps: [],
                                canceledSteps: [],
                            }),
                            sandboxStep: async () => ({ status: "complete", durationMs: 0, finishReason: null, error: null }),
                            executeTargetAssessment: async () => ({ assessmentId: "", status: "completed", bytes: 0 }),
                            dataProfile: async () => {},
                        },
                        citationResolver: createCitationResolver(),
                    },
                    shutdown: async () => {},
                }),
            },
        });

    test("the phase reaches ready, so the composer sends the turn instead of dropping it", async () => {
        await startHarnessBoot(storeFreeConfig(), storeFreeDriver);

        const settled = bootState();
        expect(settled.phase).toBe("ready");
        expect(harnessRuntime()?.conversation.model).toBe("claude-test-model");
        // `App` reads `bootState().phase === "ready"` as the `ready` gate of the submit. A `wait` verdict
        // is the dropped message a user meets as chat that answers nothing while the catalog arrives.
        expect(turnSubmitAction({ busy: false, ready: settled.phase === "ready", analysisId: "ana1", sessionId: "thr1" })).toEqual({
            kind: "send",
            sessionId: "thr1",
            analysisId: "ana1",
        });
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

    function installFakeSwitch(models: { conversation: string; sandbox: string; utility: string }): void {
        installAgentSwitch({
            swappable: {
                conversation: createSwappableProvider(fakeProvider()),
                sandbox: createSwappableProvider(fakeProvider()),
                utility: createSwappableProvider(fakeProvider()),
            },
            rebuildProvider: () => fakeProvider(),
            swapSandboxEmitters: () => {},
            modelProvider: "anthropic",
            initialModels: models,
        });
    }

    test("stays empty before ready, then seeds both agents' current models at the ready edge", async () => {
        installFakeSwitch({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" });
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels();
        });
        try {
            expect(agentModels().current).toEqual({ conversation: "", sandbox: "", utility: "" });
            await startHarnessBoot(cfg, readyDriver("claude-opus-4-8"));
            expect(agentModels().current).toEqual({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" });
        } finally {
            dispose();
        }
    });

    test("an idle swap updates the store; a switch scheduled behind work shows as pending, then clears when it lands", async () => {
        installFakeSwitch({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" });
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
