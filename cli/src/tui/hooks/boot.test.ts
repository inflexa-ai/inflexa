import { afterEach, describe, expect, test } from "bun:test";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { createRoot } from "solid-js";

import type { AgentList, AgentSelection } from "../../api/machine.ts";
import type { ServerState } from "../../api/server.ts";
import type { ClientError } from "../../client/api.ts";
import { bootState, agentModels, refreshAgentModels, watchServerBoot, watchAgentModels, __resetBootForTest, type BootWatchOpts } from "./boot.ts";
import { setChatStatus } from "./status.ts";

afterEach(() => __resetBootForTest());

const identity = { version: "0.0.0-test", apiVersion: 1, startedAt: "2026-10-02T00:00:00.000Z" } as const;
const starting: ServerState = { ...identity, phase: "starting" };
const ready = (model: string): ServerState => ({ ...identity, phase: "ready", connection: { provider: "anthropic", mode: "cliproxy", model } });

/** Watch opts that answer each read with the next of `answers` (the last one repeats), and count the reads and the sleeps. */
function scripted(answers: (() => ResultAsync<ServerState, ClientError>)[]): { opts: BootWatchOpts; reads: () => number; sleeps: () => number } {
    let reads = 0;
    let sleeps = 0;
    return {
        opts: {
            readState: () => answers[Math.min(reads++, answers.length - 1)]!(),
            sleep: async () => {
                sleeps += 1;
            },
            pollMs: 1,
        },
        reads: () => reads,
        sleeps: () => sleeps,
    };
}

describe("boot store transitions", () => {
    test("starts idle", () => {
        expect(bootState().phase).toBe("idle");
    });

    test("booting is published synchronously, then a ready server settles the store with its model and connection", async () => {
        const pending = watchServerBoot(scripted([() => okAsync(ready("claude-test"))]).opts);
        // watchServerBoot sets `booting` before its first await, so the transition is observable without
        // awaiting the read — this is what the status bar / animation mount on.
        expect(bootState().phase).toBe("booting");

        await pending;
        expect(bootState()).toEqual({ phase: "ready", model: "claude-test", connection: { provider: "anthropic", mode: "cliproxy" } });
    });

    test("a starting server is read again after each sleep, until it is ready", async () => {
        const script = scripted([() => okAsync(starting), () => okAsync(starting), () => okAsync(ready("claude-late"))]);
        await watchServerBoot(script.opts);
        expect(script.reads()).toBe(3);
        expect(script.sleeps()).toBe(2);
        expect(bootState().phase).toBe("ready");
    });

    test("a failed boot of the server publishes its actionable message", async () => {
        const failed: ServerState = {
            ...identity,
            phase: "failed",
            bootError: { reason: "runtime_already_active", message: "pid 4821 holds it", detailLines: [] },
        };
        await watchServerBoot(scripted([() => okAsync(failed)]).opts);
        expect(bootState()).toEqual({ phase: "failed", message: "pid 4821 holds it" });
    });

    test("no server that answers settles the store as failed, with the instruction to start one", async () => {
        const unreachable: ClientError = {
            type: "unreachable",
            reason: "connection_failed",
            baseUrl: "http://127.0.0.1:8436",
            cause: new Error("ECONNREFUSED"),
        };
        await watchServerBoot(scripted([() => errAsync(unreachable)]).opts);
        const settled = bootState();
        expect(settled.phase).toBe("failed");
        if (settled.phase === "failed") expect(settled.message).toContain("inflexa serve");
    });

    test("a second call while booting or ready is a no-op (it reads nothing)", async () => {
        const first = scripted([() => okAsync(starting), () => okAsync(ready("claude-first"))]);
        const pending = watchServerBoot(first.opts);
        const second = scripted([() => okAsync(ready("should-not-happen"))]);
        await watchServerBoot(second.opts);
        await pending;
        await watchServerBoot(second.opts);

        expect(second.reads()).toBe(0);
        const settled = bootState();
        if (settled.phase === "ready") expect(settled.model).toBe("claude-first");
    });
});

// The agent-models store mirrors `GET /api/v1/agents` of the server. These drive the store over a fake read
// and assert the reactive cell tracks it: seeded at the ready edge, and read again where the chat stops being
// busy, because a switch that waits for idle lands when the agent work settles.
describe("agent-models store (watchAgentModels)", () => {
    afterEach(() => setChatStatus("idle"));

    const opus: AgentSelection = { model: "claude-opus-4-8", effort: "high" };
    const sonnet: AgentSelection = { model: "claude-sonnet-4-5", effort: "medium" };

    /** An agent list with each role on `selection`, and `pending` on the conversation agent. */
    function agents(current: AgentSelection | null, pending: AgentSelection | null = null): AgentList {
        return {
            agents: [
                { role: "conversation", current, pending },
                { role: "sandbox", current: current === null ? null : sonnet, pending: null },
                { role: "utility", current: current === null ? null : sonnet, pending: null },
            ],
        };
    }

    /** A read that answers with the next of `answers` (the last one repeats), and counts the reads. */
    function scriptedAgents(answers: AgentList[]): { read: () => ResultAsync<AgentList, ClientError>; reads: () => number } {
        let reads = 0;
        return { read: () => okAsync(answers[Math.min(reads++, answers.length - 1)]!), reads: () => reads };
    }

    test("stays empty before ready, then seeds each agent's current model at the ready edge", async () => {
        const script = scriptedAgents([agents(opus)]);
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels(script.read);
        });
        try {
            expect(agentModels().current).toEqual({ conversation: "", sandbox: "", utility: "" });
            expect(agentModels().efforts).toBeNull();
            expect(script.reads()).toBe(0);
            await watchServerBoot(scripted([() => okAsync(ready("claude-opus-4-8"))]).opts);
            await Promise.sleep(0);
            expect(agentModels().current).toEqual({ conversation: "claude-opus-4-8", sandbox: "claude-sonnet-4-5", utility: "claude-sonnet-4-5" });
            expect(agentModels().efforts).toEqual({ conversation: "high", sandbox: "medium", utility: "medium" });
        } finally {
            dispose();
        }
    });

    test("a switch scheduled behind work shows as pending, and the edge where the chat stops being busy reads it landed", async () => {
        const script = scriptedAgents([agents(opus, sonnet), agents(sonnet)]);
        let dispose!: () => void;
        createRoot((d) => {
            dispose = d;
            watchAgentModels(script.read);
        });
        try {
            await watchServerBoot(scripted([() => okAsync(ready("claude-opus-4-8"))]).opts);
            await Promise.sleep(0);
            expect(agentModels().pending.get("conversation")).toEqual(sonnet);
            expect(agentModels().current.conversation).toBe("claude-opus-4-8");

            setChatStatus("busy");
            await Promise.sleep(0);
            expect(script.reads()).toBe(1);
            setChatStatus("idle");
            await Promise.sleep(0);

            expect(script.reads()).toBe(2);
            expect(agentModels().current.conversation).toBe("claude-sonnet-4-5");
            expect(agentModels().pending.size).toBe(0);
        } finally {
            dispose();
        }
    });

    test("an agent with no runtime selection keeps the efforts unknown", async () => {
        await refreshAgentModels(scriptedAgents([agents(null)]).read);
        expect(agentModels().efforts).toBeNull();
        expect(agentModels().current.conversation).toBe("");
    });

    test("a failed read keeps the store as it was", async () => {
        await refreshAgentModels(scriptedAgents([agents(opus)]).read);
        await refreshAgentModels(() => errAsync({ type: "unreachable", reason: "connection_failed", baseUrl: "http://127.0.0.1:1", cause: null }));
        expect(agentModels().current.conversation).toBe("claude-opus-4-8");
    });
});
