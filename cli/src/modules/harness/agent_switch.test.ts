import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { okAsync } from "neverthrow";
import type { AgentChat, AgentDefinition, ChatProvider, EmitFn, ModelMessage, Pool, RunProvenanceEvent, ThreadHistory } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import { createBusArtifactRegistry, createRunProvenanceEmitter } from "./prov_bridge.ts";
import { buildChatSession, runChatTurn, type ChatTurnSeams } from "./turn.ts";
import {
    __resetGaugeForTest,
    clearAgentSwitch,
    createSwappableProvider,
    currentAgentModels,
    enterChatTurn,
    installAgentSwitch,
    isAgentWorkIdle,
    noteDataProfileState,
    onAgentStateChange,
    pendingAgentSelections,
    requestAgentModelChange,
    agentProviderInner,
    type SwappableChatProvider,
} from "./agent_switch.ts";

// A provider stub tagged with its bound model so a swap is observable by identity — its `chat`/
// `chatStream` are never reached (the switch only rebuilds and swaps handles, never calls the wire).
type TaggedProvider = ChatProvider & { readonly __model: string };
function fakeProvider(model: string): TaggedProvider {
    return {
        __model: model,
        capabilities: { toolCalling: true },
        chat: () => {
            throw new Error("chat must not be called in switch tests");
        },
        chatStream: () => {
            throw new Error("chatStream must not be called in switch tests");
        },
        // The `chat`/`chatStream` stubs are structurally incompatible with the real Result/AsyncIterable
        // return types, but no test path invokes them, so the double cast is honest here.
    } as unknown as TaggedProvider;
}

/** Read the bound model of the inner provider an agent's swappable handle currently delegates to. */
function agentModel(handle: SwappableChatProvider): string {
    return (agentProviderInner(handle) as TaggedProvider).__model;
}

// Install a switch over fully-faked wiring. `swapSandboxEmitters` mirrors `runtime.ts`: it reconstructs
// the sandbox run emitter WITH the new name into a holder, and the returned emit helpers read that
// holder at call time — so an event emitted before a swap carries the old name and one after carries the
// new, exactly as an in-flight run's steps vs. a post-swap run's steps would.
function setup(models: { conversation: string; sandbox: string } = { conversation: "claude-conv", sandbox: "claude-sand" }): {
    swappable: Record<"conversation" | "sandbox", SwappableChatProvider>;
    rebuildCount: () => number;
    emitterSwapNames: string[];
    emitRunStarted: (runId: string) => void;
    emitRunCompleted: (runId: string) => void;
    emitStepCompleted: () => void;
} {
    const swappable = {
        conversation: createSwappableProvider(fakeProvider(models.conversation)),
        sandbox: createSwappableProvider(fakeProvider(models.sandbox)),
    };
    let sandboxRunEmitter = createRunProvenanceEmitter(`anthropic/${models.sandbox}`);
    const emitterSwapNames: string[] = [];
    let rebuilds = 0;

    installAgentSwitch({
        swappable,
        rebuildProvider: (model) => {
            rebuilds += 1;
            return fakeProvider(model);
        },
        swapSandboxEmitters: (name) => {
            emitterSwapNames.push(name);
            // The registry is reconstructed identically in the real closure; keep the parity even though
            // these tests assert through the run emitter's `prov.step_completed`.
            createBusArtifactRegistry(name);
            sandboxRunEmitter = createRunProvenanceEmitter(name);
        },
        modelProvider: "anthropic",
        initialModels: { conversation: models.conversation, sandbox: models.sandbox },
    });

    const runStarted = (runId: string): RunProvenanceEvent => ({ type: "run_started", analysisId: "an-1", runId, planSummary: "p", stepCount: 1, atMs: 1 });
    const runCompleted = (runId: string): RunProvenanceEvent => ({
        type: "run_completed",
        analysisId: "an-1",
        runId,
        status: "completed",
        atMs: 9,
        durationMs: 8,
    });
    const stepCompleted: RunProvenanceEvent = { type: "step_completed", analysisId: "an-1", runId: "run-1", stepId: "step-1", status: "completed", atMs: 5 };

    return {
        swappable,
        rebuildCount: () => rebuilds,
        emitterSwapNames,
        emitRunStarted: (runId) => sandboxRunEmitter(runStarted(runId)),
        emitRunCompleted: (runId) => sandboxRunEmitter(runCompleted(runId)),
        emitStepCompleted: () => sandboxRunEmitter(stepCompleted),
    };
}

// Bus spy — capture every emitted event so a `prov.step_completed`'s recorded model can be asserted
// across a swap. Always detach in cleanup so no listener leaks across tests.
let captured: StampedEvent[] = [];
function spy(event: StampedEvent): void {
    captured.push(event);
}

function lastStepModel(): string {
    const step = [...captured].reverse().find((e) => e.type === "prov.step_completed");
    if (step === undefined || step.type !== "prov.step_completed") throw new Error("no prov.step_completed captured");
    return step.model;
}

beforeEach(() => {
    __resetGaugeForTest();
    clearAgentSwitch();
    captured = [];
    Bus.on("inflexa", spy);
});
afterEach(() => {
    Bus.off("inflexa", spy);
    clearAgentSwitch();
    __resetGaugeForTest();
});

describe("agent-work gauge", () => {
    test("a chat turn holds the gauge busy until its bracket settles", () => {
        expect(isAgentWorkIdle()).toBe(true);
        const leave = enterChatTurn();
        expect(isAgentWorkIdle()).toBe(false);
        leave();
        expect(isAgentWorkIdle()).toBe(true);
        // A second leave is a no-op — the bracket cannot drive the gauge below the work actually present.
        leave();
        expect(isAgentWorkIdle()).toBe(true);
    });

    test("runs are tracked by the run bus: started ⇒ busy, completed ⇒ idle", () => {
        const h = setup();
        expect(isAgentWorkIdle()).toBe(true);
        h.emitRunStarted("run-1");
        expect(isAgentWorkIdle()).toBe(false);
        h.emitRunCompleted("run-1");
        expect(isAgentWorkIdle()).toBe(true);
    });

    test("a data profile reported running holds the gauge busy until reported settled (indeterminate defers)", () => {
        setup();
        noteDataProfileState("an-1", true);
        expect(isAgentWorkIdle()).toBe(false);
        noteDataProfileState("an-1", false);
        expect(isAgentWorkIdle()).toBe(true);
    });
});

describe("agent switch — idle applies immediately", () => {
    test("switching the sandbox model while idle applies now, rebuilds the provider, and re-stamps the emitters", () => {
        const h = setup();
        const result = requestAgentModelChange("sandbox", "claude-new");

        expect(result).toEqual({ status: "applied" });
        expect(agentModel(h.swappable.sandbox)).toBe("claude-new");
        expect(currentAgentModels().sandbox).toBe("claude-new");
        expect(h.emitterSwapNames).toEqual(["anthropic/claude-new"]);
        // The next step records the NEW name.
        h.emitStepCompleted();
        expect(lastStepModel()).toBe("anthropic/claude-new");
    });

    test("switching the chat model while idle re-points only the conversation agent (not sandbox, no emitter swap)", () => {
        const h = setup({ conversation: "same-model", sandbox: "same-model" });
        const sandboxInnerBefore = agentProviderInner(h.swappable.sandbox);

        const result = requestAgentModelChange("conversation", "claude-chat-new");

        expect(result).toEqual({ status: "applied" });
        expect(agentModel(h.swappable.conversation)).toBe("claude-chat-new");
        // The sandbox agent's inner is untouched (independent per-agent handles — D4) and no emitter swapped
        // (the conversation agent drives no provenance).
        expect(agentProviderInner(h.swappable.sandbox)).toBe(sandboxInnerBefore);
        expect(h.emitterSwapNames).toEqual([]);
    });

    test("selecting the model an agent already runs is a no-op that reports applied without a rebuild", () => {
        const h = setup();
        const result = requestAgentModelChange("sandbox", "claude-sand");

        expect(result).toEqual({ status: "applied" });
        expect(h.rebuildCount()).toBe(0);
        expect(pendingAgentSelections().size).toBe(0);
    });
});

describe("agent switch — busy schedules, then lands at settlement", () => {
    test("a switch behind a run is scheduled; the in-flight run records the OLD model, post-swap steps the NEW", () => {
        const h = setup();
        h.emitRunStarted("run-1");

        // The in-flight run's steps still record the model that started it.
        h.emitStepCompleted();
        expect(lastStepModel()).toBe("anthropic/claude-sand");

        const result = requestAgentModelChange("sandbox", "claude-next");
        expect(result).toEqual({ status: "scheduled" });
        expect(pendingAgentSelections().get("sandbox")).toBe("claude-next");
        // Not yet applied — the provider still delegates to the old inner and no emitter re-stamped.
        expect(agentModel(h.swappable.sandbox)).toBe("claude-sand");
        expect(h.emitterSwapNames).toEqual([]);

        // The run settles → last in-flight work gone → the pending switch lands.
        h.emitRunCompleted("run-1");
        expect(agentModel(h.swappable.sandbox)).toBe("claude-next");
        expect(currentAgentModels().sandbox).toBe("claude-next");
        expect(pendingAgentSelections().size).toBe(0);
        // Subsequent steps record the NEW name.
        h.emitStepCompleted();
        expect(lastStepModel()).toBe("anthropic/claude-next");
    });

    test("a switch behind a streaming chat turn defers to the turn boundary", () => {
        const h = setup();
        const leaveTurn = enterChatTurn();

        const result = requestAgentModelChange("conversation", "claude-chat-next");
        expect(result).toEqual({ status: "scheduled" });
        expect(agentModel(h.swappable.conversation)).toBe("claude-conv");

        // The turn finishes → the swap lands before the next turn begins.
        leaveTurn();
        expect(agentModel(h.swappable.conversation)).toBe("claude-chat-next");
        expect(pendingAgentSelections().size).toBe(0);
    });

    // The streaming-interruption defect (agent-model-selection task 8): the REPORTED gesture is switching
    // the chat model WHILE a response streams. This drives the actual TUI turn engine (`runChatTurn`,
    // which `conversation.send` awaits) — NOT a bare `enterChatTurn` — with a multi-chunk streaming
    // provider, and requests the switch from INSIDE the stream. It proves the gauge bracket the real
    // engine installs holds for the WHOLE streamed turn: the switch defers, the in-flight provider inner
    // is never re-pointed mid-stream, every chunk is delivered untruncated, and the swap lands only after
    // the turn settles. This is the level the (non-)defect lives at — the request path, not presentation.
    test("switching mid-stream through the real runChatTurn never truncates the stream; the swap lands after the turn", async () => {
        const h = setup();

        const emitted: string[] = [];
        // Snapshotted at the instant the switch is requested mid-stream, so the assertions can prove the
        // gauge was busy and the provider inner untouched AT THAT MOMENT (not merely by the end). An array
        // (not a `let … | null`) so control-flow narrowing doesn't collapse the closure-written value to null.
        const midStream: { status: string; idle: boolean; innerModel: string }[] = [];

        // A `run` seam standing in for `runAgent`: it streams several text deltas with an await between
        // each (a real network stream yields to the loop), and at the third delta requests the chat-model
        // switch — the reported gesture. The awaits ensure the switch is requested while the turn is
        // genuinely mid-flight, inside `runChatTurn`'s gauge bracket.
        const chunks = ["Each ", "analysis ", "row ", "carries ", "a slug."];
        const streamingRun: ChatTurnSeams["run"] = async (_agent, initial, _session, ctx) => {
            for (let i = 0; i < chunks.length; i++) {
                await Promise.resolve();
                void (ctx.emit as EmitFn)({ type: "text-delta", text: chunks[i]! } as never);
                emitted.push(chunks[i]!);
                if (i === 2) {
                    const result = requestAgentModelChange("conversation", "claude-mid-stream");
                    midStream.push({ status: result.status, idle: isAgentWorkIdle(), innerModel: agentModel(h.swappable.conversation) });
                }
            }
            return {
                messages: [...initial, { role: "assistant", content: chunks.join("") } as ModelMessage],
                finish: { reason: "stop", cappedOut: false, truncationRecoveries: 0 },
            };
        };
        const prepareOk: ChatTurnSeams["prepare"] = () =>
            Promise.resolve({ kind: "ok", messages: [{ role: "user", content: "?" }], userMessage: { role: "user", content: "?" } });
        const history: ThreadHistory = {
            appendTurn: () => okAsync(undefined),
            loadRecent: () => okAsync([]),
            loadPage: () => okAsync({ messages: [], total: 0, page: 1, perPage: 200, hasMore: false }),
        } as unknown as ThreadHistory;

        const outcome = await runChatTurn(
            {
                pool: {} as unknown as Pool,
                conversationAgent: { id: "conv" } as unknown as AgentDefinition,
                chat: {} as unknown as AgentChat,
                history,
                session: buildChatSession("tui-chat", "an-1", "t-1"),
                emit: (() => {}) as EmitFn,
                signal: new AbortController().signal,
                analysisId: "an-1",
                threadId: "t-1",
                userInput: "?",
            },
            { prepare: prepareOk, run: streamingRun },
        );

        // The stream ran to completion — every chunk delivered, none dropped.
        expect(emitted).toEqual(chunks);
        expect(outcome.kind).toBe("ok");
        // Mid-stream: the gauge was BUSY (the real bracket held), so the switch was SCHEDULED and the
        // in-flight provider inner was NEVER re-pointed — no request observed a mid-flight model change.
        expect(midStream).toEqual([{ status: "scheduled", idle: false, innerModel: "claude-conv" }]);
        // The swap lands only once the turn's bracket settles, before any next turn.
        expect(isAgentWorkIdle()).toBe(true);
        expect(agentModel(h.swappable.conversation)).toBe("claude-mid-stream");
        expect(currentAgentModels().conversation).toBe("claude-mid-stream");
        expect(pendingAgentSelections().size).toBe(0);
    });

    test("the swap waits for the LAST in-flight work, not the first to settle", () => {
        const h = setup();
        const leaveTurn = enterChatTurn();
        h.emitRunStarted("run-1");

        requestAgentModelChange("sandbox", "claude-last");
        expect(pendingAgentSelections().get("sandbox")).toBe("claude-last");

        // Chat turn ends, but the run is still in flight → still pending.
        leaveTurn();
        expect(agentModel(h.swappable.sandbox)).toBe("claude-sand");
        expect(pendingAgentSelections().size).toBe(1);

        // The run settles → now idle → applied.
        h.emitRunCompleted("run-1");
        expect(agentModel(h.swappable.sandbox)).toBe("claude-last");
        expect(pendingAgentSelections().size).toBe(0);
    });

    test("a switch behind a running data profile schedules, then lands when the profile is reported settled", () => {
        const h = setup();
        noteDataProfileState("an-1", true);

        expect(requestAgentModelChange("sandbox", "claude-after-profile")).toEqual({ status: "scheduled" });
        expect(agentModel(h.swappable.sandbox)).toBe("claude-sand");

        noteDataProfileState("an-1", false);
        expect(agentModel(h.swappable.sandbox)).toBe("claude-after-profile");
    });
});

describe("agent switch — state notifications + no active runtime", () => {
    test("onAgentStateChange fires on schedule and on apply", () => {
        const h = setup();
        let notifications = 0;
        const unsub = onAgentStateChange(() => {
            notifications += 1;
        });

        h.emitRunStarted("run-1");
        requestAgentModelChange("sandbox", "claude-x"); // scheduled → 1 notify
        expect(notifications).toBe(1);
        h.emitRunCompleted("run-1"); // applied at idle → 1 notify
        expect(notifications).toBe(2);

        unsub();
        requestAgentModelChange("conversation", "claude-y"); // idle apply, but unsubscribed
        expect(notifications).toBe(2);
    });

    test("a change requested with no live runtime reports scheduled (config persists it for next boot)", () => {
        // No `installAgentSwitch` this test — the beforeEach cleared any prior controller.
        expect(requestAgentModelChange("sandbox", "whatever")).toEqual({ status: "scheduled" });
        expect(currentAgentModels()).toEqual({ conversation: "", sandbox: "" });
        expect(pendingAgentSelections().size).toBe(0);
    });
});
