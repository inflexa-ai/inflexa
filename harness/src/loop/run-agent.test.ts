import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { isSyntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import { AskRejectedError } from "../tools/approval/contract.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, type ScriptedProvider, textBlock, thinkingBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import type { AgentDefinition, EmitEvent, RunStep } from "./types.js";

// ── Harness helpers ─────────────────────────────────────────────────

function agentDef(tools: Tool[], maxIterations = 8): AgentDefinition {
    return {
        id: "test-agent",
        systemPrompt: "You are a test agent.",
        model: "claude-test",
        tools,
        maxIterations,
    };
}

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

function opts(provider: ScriptedProvider, overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return {
        provider,
        signal: new AbortController().signal,
        emit: () => {},
        runStep: passthroughStep,
        ...overrides,
    };
}

/** A `RunStep` that records every step name it is asked to wrap. */
function recordingStep(): { runStep: RunStep; names: string[] } {
    const names: string[] = [];
    const runStep: RunStep = (name, fn) => {
        names.push(name);
        return fn();
    };
    return { runStep, names };
}

function toolResultParts(message: ModelMessage | undefined): ToolResultPart[] {
    expect(message).toBeDefined();
    expect(message!.role).toBe("tool");
    expect(Array.isArray(message!.content)).toBe(true);
    return message!.content as ToolResultPart[];
}

function outputValue(result: ToolResultPart): unknown {
    return result.output.type === "json" || result.output.type === "text" || result.output.type === "error-text" ? result.output.value : result.output;
}

function isErrorResult(result: ToolResultPart): boolean {
    return result.output.type === "error-text" || result.output.type === "error-json" || result.output.type === "execution-denied";
}

/** An `echo` tool whose `execute` optionally waits `ms` then returns the label. */
function echoTool(): Tool {
    return defineTool({
        id: "echo",
        description: "Echo the label back after an optional delay.",
        inputSchema: z.object({
            label: z.string(),
            ms: z.number().default(0),
        }),
        execute: async ({ label, ms }) => {
            if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
            return ok({ label });
        },
    });
}

// ── 5.1 — signed provider metadata round-trip (invariant 1) ──────────

describe("runAgent — invariant 1: provider metadata", () => {
    it("round-trips signed reasoning provider metadata byte-for-byte", async () => {
        const provider = scriptedProvider([makeMessage([thinkingBlock("let me reason", "SIG-abc-123"), textBlock("answer")], "end_turn")]);

        const { messages } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        const assistant = messages.at(-1)!;
        expect(assistant.role).toBe("assistant");
        const content = assistant.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
        const reasoning = content.find((b) => b.type === "reasoning");
        expect(reasoning).toMatchObject({
            type: "reasoning",
            text: "let me reason",
            providerOptions: { anthropic: { signature: "SIG-abc-123" } },
        });
    });
});

// ── 5.2 — tool-result placement (invariant 2) ───────────────────────

describe("runAgent — invariant 2: tool-results in one tool message", () => {
    it("places N tool-result parts in exactly one tool message", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [toolUseBlock("tu-1", "echo", { label: "a" }), toolUseBlock("tu-2", "echo", { label: "b" }), toolUseBlock("tu-3", "echo", { label: "c" })],
                "tool_use",
            ),
            makeMessage([textBlock("all done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(3 tool-call), tool(3 tool-result), assistant(text)]
        expect(messages).toHaveLength(4);
        const blocks = toolResultParts(messages[2]);
        expect(blocks).toHaveLength(3);
        expect(blocks.every((b) => b.type === "tool-result")).toBe(true);
    });
});

// ── 5.3 — parallel association (invariant 3) ────────────────────────

describe("runAgent — invariant 3: tool-result association", () => {
    it("assembles results in [A,B,C] even when they resolve C,B,A", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [
                    toolUseBlock("tu-A", "echo", { label: "A", ms: 30 }),
                    toolUseBlock("tu-B", "echo", { label: "B", ms: 15 }),
                    toolUseBlock("tu-C", "echo", { label: "C", ms: 1 }),
                ],
                "tool_use",
            ),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-A", "tu-B", "tu-C"]);
    });
});

// ── 5.4 — append-only (invariant 4) ─────────────────────────────────

describe("runAgent — invariant 4: append-only message array", () => {
    it("never mutates prior messages and preserves their identity", async () => {
        const u0 = Object.freeze({ role: "user" as const, content: "go" });
        const initial = Object.freeze([u0]);
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), initial, makeSession(), opts(provider));

        expect(messages).not.toBe(initial);
        // The initial message survives by reference — frozen, so any mutation
        // attempt inside the loop would have thrown.
        expect(messages[0]).toBe(u0);
        expect(messages[0]).toEqual({ role: "user", content: "go" });
        expect(messages.length).toBeGreaterThan(initial.length);
    });
});

// ── 5.5 — step-name determinism ─────────────────────────────────────

describe("runAgent — deterministic step names", () => {
    function buildProvider(): ScriptedProvider {
        return scriptedProvider([makeMessage([toolUseBlock("tu-fixed-1", "echo", { label: "x" })], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);
    }

    it("emits the identical step-name sequence over identical inputs", async () => {
        const first = recordingStep();
        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(buildProvider(), { runStep: first.runStep }));

        const second = recordingStep();
        await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(buildProvider(), { runStep: second.runStep }));

        expect(first.names).toEqual(["llm-0", "tool-echo-tu-fixed-1", "llm-1"]);
        expect(second.names).toEqual(first.names);
    });
});

describe("runAgent — provider capability gate", () => {
    it("rejects tool-required agents before the first model call when tool calling is unavailable", async () => {
        const provider: ScriptedProvider = {
            ...scriptedProvider([makeMessage([textBlock("should not be called")], "end_turn")]),
            capabilities: { toolCalling: false },
        };

        await expect(runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider))).rejects.toThrow(/cannot run tool-required agent/);
        expect(provider.calls).toHaveLength(0);
    });
});

// ── executionMode partition (see the harness-tools spec) ─────────────

describe("runAgent — workflow tools run unwrapped, in order", () => {
    function workflowTool(): Tool {
        return defineTool({
            id: "workflow",
            description: "A workflow-backed tool.",
            executionMode: "workflow",
            inputSchema: z.object({ label: z.string() }),
            execute: async ({ label }) => ok({ label }),
        });
    }

    it("dispatches a workflow tool without a runStep wrap; step tools still wrapped", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-w", "echo", { label: "w" }), toolUseBlock("tu-b", "workflow", { label: "b" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const rec = recordingStep();
        const { messages } = await runAgent(agentDef([echoTool(), workflowTool()]), GO, makeSession(), opts(provider, { runStep: rec.runStep }));

        expect(rec.names).toEqual(["llm-0", "tool-echo-tu-w", "llm-1"]);

        // Results are assembled by original index regardless of execution order.
        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-w", "tu-b"]);
        expect(outputValue(blocks[1]!)).toEqual({ label: "b" });
    });
});

// ── 5.6 — max-iteration wrap-up ─────────────────────────────────────

describe("runAgent — max-iteration wrap-up", () => {
    it("forces one tool-less call at the cap and returns without throwing", async () => {
        // The provider never stops asking for tools — except when handed an
        // empty tool list, which forces the wrap-up text reply.
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && Object.keys(request.tools).length === 0
                ? makeMessage([textBlock("here is where I reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { messages } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        // 3 capped iterations + 1 forced wrap-up call.
        expect(provider.calls).toHaveLength(4);
        expect(provider.calls[3]!.tools).toEqual({});

        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        const content = last.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
        expect(content.some((b) => b.type === "text" && b.text === "here is where I reached")).toBe(true);
    });
});

// ── Tool-error boundary (spec scenarios) ────────────────────────────

describe("runAgent — tool-error boundary", () => {
    it("wraps a throwing tool as an is_error tool_result and continues", async () => {
        const boom = defineTool({
            id: "boom",
            description: "Always throws.",
            inputSchema: z.object({}),
            execute: async () => {
                throw new Error("kaboom");
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "boom", {})], "tool_use"), makeMessage([textBlock("recovered")], "end_turn")]);

        const { messages } = await runAgent(agentDef([boom]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("kaboom");
        expect(messages.at(-1)!.role).toBe("assistant");
    });

    it("unwraps an ok(value) Result into a non-error tool_result", async () => {
        const okTool = defineTool({
            id: "ok_tool",
            description: "Returns an ok Result.",
            inputSchema: z.object({}),
            execute: async () => ok({ answer: 42 }),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "ok_tool", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(agentDef([okTool]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(false);
        expect(outputValue(result)).toEqual({ answer: 42 });
    });

    it("maps an err(ToolError) Result to an is_error tool_result verbatim", async () => {
        const errTool = defineTool({
            id: "err_tool",
            description: "Returns an err Result.",
            inputSchema: z.object({}),
            execute: async () => err({ error: "upstream down", retryable: true } as const),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "err_tool", {})], "tool_use"), makeMessage([textBlock("recovered")], "end_turn")]);

        const { messages } = await runAgent(agentDef([errTool]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(JSON.parse(String(outputValue(result)))).toEqual({
            error: "upstream down",
            retryable: true,
        });
    });

    it("rejects Zod-invalid tool input before execute runs", async () => {
        let executed = false;
        const strict = defineTool({
            id: "strict",
            description: "Needs a number.",
            inputSchema: z.object({ n: z.number() }),
            execute: async () => {
                executed = true;
                return ok({ ok: true });
            },
        });
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "strict", { n: "not-a-number" })], "tool_use"),
            makeMessage([textBlock("ok")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([strict]), GO, makeSession(), opts(provider));

        expect(executed).toBe(false);
        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("input validation failed");
    });

    it("re-raises fatal workflow-backed errors instead of returning an error tool result", async () => {
        const fatal = new Error("workflow cancelled");
        const workflow = defineTool({
            id: "workflow_fatal",
            description: "Throws a fatal workflow error.",
            executionMode: "workflow",
            inputSchema: z.object({}),
            execute: async () => {
                throw fatal;
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "workflow_fatal", {})], "tool_use")]);

        await expect(
            runAgent(
                agentDef([workflow]),
                GO,
                makeSession(),
                opts(provider, {
                    isFatalLoopError: (err) => err === fatal,
                }),
            ),
        ).rejects.toBe(fatal);
    });
});

// ── max_tokens is a recoverable soft-error (see the harness-agent-loop spec) ───────────────

describe("runAgent — max_tokens recovery", () => {
    it("refuses a truncated trailing tool_use, feeds back a retryable error, and continues", async () => {
        let executed = false;
        const writer = defineTool({
            id: "writer",
            description: "Writes a payload.",
            inputSchema: z.object({ body: z.string() }),
            execute: async () => {
                executed = true;
                return ok({ ok: true });
            },
        });
        const provider = scriptedProvider([
            // Truncated at the output cap mid-tool-call.
            makeMessage([toolUseBlock("tu-cut", "writer", { body: "half a file" })], "max_tokens"),
            makeMessage([textBlock("recovered")], "end_turn"),
        ]);

        const { messages, finish } = await runAgent(agentDef([writer]), GO, makeSession(), opts(provider));

        // The truncated trailing tool_use was NOT dispatched.
        expect(executed).toBe(false);

        // A retryable is_error tool_result was synthesized for it, preserving the
        // tool_use↔tool_result pairing.
        const result = toolResultParts(messages[2])[0]!;
        expect(result.type).toBe("tool-result");
        expect(result.toolCallId).toBe("tu-cut");
        expect(isErrorResult(result)).toBe(true);
        expect(String(outputValue(result))).toContain("cut off");

        // The loop continued to a clean terminal reply and counted the recovery.
        expect(finish.reason).toBe("stop");
        expect(finish.truncationRecoveries).toBe(1);
        expect(messages.at(-1)!.role).toBe("assistant");
    });

    it("dispatches earlier complete tool_uses but refuses the truncated trailing one", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-A", "echo", { label: "A" }), toolUseBlock("tu-B", "echo", { label: "B-cut" })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const blocks = toolResultParts(messages[2]);
        expect(blocks.map((b) => b.toolCallId)).toEqual(["tu-A", "tu-B"]);
        // The earlier tool ran (no error); the trailing one was refused.
        expect(isErrorResult(blocks[0]!)).toBe(false);
        expect(isErrorResult(blocks[1]!)).toBe(true);
    });

    it("steers and continues on truncated prose (no tool_use)", async () => {
        const provider = scriptedProvider([
            makeMessage([textBlock("a very long answer that got cut")], "max_tokens"),
            makeMessage([textBlock("finished")], "end_turn"),
        ]);

        const { messages, finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        // [user, assistant(truncated), user(steer), assistant(finished)]
        expect(messages).toHaveLength(4);
        const steer = messages[2]!;
        expect(steer.role).toBe("user");
        expect(String(steer.content)).toContain("cut off");
        // The steer must be marked synthetic. It carries the `user` role only because the wire format
        // demands one after a truncated assistant message — a reader that took it for user input would
        // see a turn boundary in the middle of this turn, and a tail-turn removal would cut there.
        expect(isSyntheticUserMessage(steer)).toBe(true);
        // The opening prompt is real user input and must NOT be marked, or the boundary vanishes entirely.
        expect(isSyntheticUserMessage(messages[0]!)).toBe(false);
        expect(finish.reason).toBe("stop");
        expect(finish.truncationRecoveries).toBe(1);
    });
});

// ── finish signal on a clean stop ───────────────────────────────────

describe("runAgent — finish signal", () => {
    it("returns the real terminal stop_reason with no recoveries on a clean stop", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish).toEqual({
            reason: "stop",
            cappedOut: false,
            truncationRecoveries: 0,
        });
    });

    it("reports cappedOut with reason max_iterations on the wrap-up path", async () => {
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && Object.keys(request.tools).length === 0
                ? makeMessage([textBlock("reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        expect(finish.cappedOut).toBe(true);
        expect(finish.reason).toBe("max_iterations");
    });
});

// ── Approval denial: deny-default + turn hard-stop ──────────────────

/** A tool that pauses on `ctx.ask` before its guarded action. */
function guardedTool(): Tool {
    return defineTool({
        id: "guarded",
        description: "Requests approval before acting.",
        inputSchema: z.object({}),
        execute: async (_input, ctx) => {
            await ctx.ask({ title: "Guarded action", command: "delete everything" });
            return ok({ ran: true });
        },
    });
}

function deniedReason(result: ToolResultPart): string {
    expect(result.output.type).toBe("execution-denied");
    return (result.output as { type: "execution-denied"; reason: string }).reason;
}

describe("runAgent — approval denial", () => {
    it("denies by default when no ask realization is wired and marks the finish denied", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "guarded", {})], "tool_use")]);

        const { messages, finish } = await runAgent(agentDef([guardedTool()]), GO, makeSession(), opts(provider));

        const result = toolResultParts(messages[2])[0]!;
        expect(result.output.type).toBe("execution-denied");
        expect(finish.reason).toBe("denied");
        // The hard-stop makes no subsequent model call.
        expect(provider.calls).toHaveLength(1);
    });

    it("hard-stops the turn on denial while a concurrent sibling's result is still appended", async () => {
        const plain = defineTool({
            id: "plain",
            description: "An ordinary tool.",
            inputSchema: z.object({}),
            execute: async () => ok({ b: true }),
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-A", "guarded", {}), toolUseBlock("tu-B", "plain", {})], "tool_use")]);

        const { messages, finish } = await runAgent(
            agentDef([guardedTool(), plain]),
            GO,
            makeSession(),
            opts(provider, {
                ask: async () => {
                    throw new AskRejectedError("nope");
                },
            }),
        );

        const results = toolResultParts(messages[2]);
        const denied = results.find((r) => r.toolCallId === "tu-A")!;
        const sibling = results.find((r) => r.toolCallId === "tu-B")!;

        // The sibling ran to completion and its result rides alongside the denial.
        expect(isErrorResult(sibling)).toBe(false);
        expect(outputValue(sibling)).toEqual({ b: true });
        // The denial carries the user's feedback prose.
        expect(deniedReason(denied)).toContain("nope");
        expect(finish.reason).toBe("denied");
        // No second model call — the denial is the turn's final content.
        expect(provider.calls).toHaveLength(1);
    });

    it("does not terminate the turn when the approval returns once", async () => {
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "guarded", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages, finish } = await runAgent(agentDef([guardedTool()]), GO, makeSession(), opts(provider, { ask: async () => ({ kind: "once" }) }));

        const result = toolResultParts(messages[2])[0]!;
        expect(isErrorResult(result)).toBe(false);
        expect(outputValue(result)).toEqual({ ran: true });
        expect(finish.reason).toBe("stop");
        // The loop continued to a normal terminal reply — a second model call.
        expect(provider.calls).toHaveLength(2);
    });
});

// ── Event sourcing (task 2.7) ───────────────────────────────────────

describe("runAgent — event provenance", () => {
    it("stamps every event with source from the Session", async () => {
        const events: EmitEvent[] = [];
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-1", "echo", { label: "x" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);
        const session = makeSession({
            agentId: "conversation-agent",
            callPath: ["conversation-agent"],
        });

        await runAgent(
            agentDef([echoTool()]),
            GO,
            session,
            opts(provider, {
                emit: (e) => {
                    events.push(e as EmitEvent);
                },
            }),
        );

        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
            expect(event.source.agentId).toBe("conversation-agent");
            expect(event.source.callPath).toEqual(["conversation-agent"]);
        }
        expect(events.map((e) => e.type)).toContain("tool-started");
        expect(events.map((e) => e.type)).toContain("tool-finished");
    });
});
