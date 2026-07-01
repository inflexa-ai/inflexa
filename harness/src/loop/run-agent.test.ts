import { describe, expect, it } from "bun:test";
import type { ContentBlock, ContentBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
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

// ── 5.1 — signed thinking round-trip (invariant 1) ──────────────────

describe("runAgent — invariant 1: verbatim assistant content", () => {
    it("round-trips a signed thinking block byte-for-byte", async () => {
        const provider = scriptedProvider([makeMessage([thinkingBlock("let me reason", "SIG-abc-123"), textBlock("answer")], "end_turn")]);

        const { messages } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        const assistant = messages.at(-1)!;
        expect(assistant.role).toBe("assistant");
        const content = assistant.content as ContentBlock[];
        const thinking = content.find((b) => b.type === "thinking");
        expect(thinking).toMatchObject({
            type: "thinking",
            thinking: "let me reason",
            signature: "SIG-abc-123",
        });
    });
});

// ── 5.2 — tool_result placement (invariant 2) ───────────────────────

describe("runAgent — invariant 2: tool_results in one user message", () => {
    it("places N tool_results in exactly one user message, no interleaved text", async () => {
        const provider = scriptedProvider([
            makeMessage(
                [toolUseBlock("tu-1", "echo", { label: "a" }), toolUseBlock("tu-2", "echo", { label: "b" }), toolUseBlock("tu-3", "echo", { label: "c" })],
                "tool_use",
            ),
            makeMessage([textBlock("all done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        // [user, assistant(3 tool_use), user(3 tool_result), assistant(text)]
        expect(messages).toHaveLength(4);
        const resultMsg = messages[2]!;
        expect(resultMsg.role).toBe("user");
        const blocks = resultMsg.content as ContentBlockParam[];
        expect(blocks).toHaveLength(3);
        expect(blocks.every((b) => b.type === "tool_result")).toBe(true);
    });
});

// ── 5.3 — parallel order (invariant 3) ──────────────────────────────

describe("runAgent — invariant 3: array-order tool_results", () => {
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

        const blocks = messages[2]!.content as ToolResultBlockParam[];
        expect(blocks.map((b) => b.tool_use_id)).toEqual(["tu-A", "tu-B", "tu-C"]);
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

// ── bodyContext partition (see the harness-tools spec) ────────────────────────────────

describe("runAgent — bodyContext tools run unwrapped, in order", () => {
    /** A `bodyContext` tool — must NOT be wrapped in `runStep` by the loop. */
    function bodyTool(): Tool {
        return defineTool({
            id: "body",
            description: "A body-context tool.",
            bodyContext: true,
            inputSchema: z.object({ label: z.string() }),
            execute: async ({ label }) => ok({ label }),
        });
    }

    it("dispatches a bodyContext tool without a runStep wrap; wrapped tools still wrapped", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-w", "echo", { label: "w" }), toolUseBlock("tu-b", "body", { label: "b" })], "tool_use"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const rec = recordingStep();
        const { messages } = await runAgent(agentDef([echoTool(), bodyTool()]), GO, makeSession(), opts(provider, { runStep: rec.runStep }));

        // The wrapped `echo` reserves a `tool-...` step; the `bodyContext` `body`
        // tool runs unwrapped — no `tool-body-*` name is ever handed to `runStep`.
        expect(rec.names).toEqual(["llm-0", "tool-echo-tu-w", "llm-1"]);

        // Results are assembled by original index regardless of execution order.
        const blocks = messages[2]!.content as ToolResultBlockParam[];
        expect(blocks.map((b) => b.tool_use_id)).toEqual(["tu-w", "tu-b"]);
        expect(String(blocks[1]!.content)).toContain("b");
    });
});

// ── 5.6 — max-iteration wrap-up ─────────────────────────────────────

describe("runAgent — max-iteration wrap-up", () => {
    it("forces one tool-less call at the cap and returns without throwing", async () => {
        // The provider never stops asking for tools — except when handed an
        // empty tool list, which forces the wrap-up text reply.
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && request.tools.length === 0
                ? makeMessage([textBlock("here is where I reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { messages } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        // 3 capped iterations + 1 forced wrap-up call.
        expect(provider.calls).toHaveLength(4);
        expect(provider.calls[3]!.tools).toEqual([]);

        const last = messages.at(-1)!;
        expect(last.role).toBe("assistant");
        const content = last.content as ContentBlock[];
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

        const result = (messages[2]!.content as ToolResultBlockParam[])[0]!;
        expect(result.is_error).toBe(true);
        expect(String(result.content)).toContain("kaboom");
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

        const result = (messages[2]!.content as ToolResultBlockParam[])[0]!;
        expect(result.is_error).not.toBe(true);
        expect(JSON.parse(String(result.content))).toEqual({ answer: 42 });
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

        const result = (messages[2]!.content as ToolResultBlockParam[])[0]!;
        expect(result.is_error).toBe(true);
        expect(JSON.parse(String(result.content))).toEqual({
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
        const result = (messages[2]!.content as ToolResultBlockParam[])[0]!;
        expect(result.is_error).toBe(true);
        expect(String(result.content)).toContain("input validation failed");
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
        const result = (messages[2]!.content as ToolResultBlockParam[])[0]!;
        expect(result.type).toBe("tool_result");
        expect(result.tool_use_id).toBe("tu-cut");
        expect(result.is_error).toBe(true);
        expect(String(result.content)).toContain("cut off");

        // The loop continued to a clean terminal reply and counted the recovery.
        expect(finish.reason).toBe("end_turn");
        expect(finish.truncationRecoveries).toBe(1);
        expect(messages.at(-1)!.role).toBe("assistant");
    });

    it("dispatches earlier complete tool_uses but refuses the truncated trailing one", async () => {
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-A", "echo", { label: "A" }), toolUseBlock("tu-B", "echo", { label: "B-cut" })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([echoTool()]), GO, makeSession(), opts(provider));

        const blocks = messages[2]!.content as ToolResultBlockParam[];
        expect(blocks.map((b) => b.tool_use_id)).toEqual(["tu-A", "tu-B"]);
        // The earlier tool ran (no error); the trailing one was refused.
        expect(blocks[0]!.is_error).not.toBe(true);
        expect(blocks[1]!.is_error).toBe(true);
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
        expect(finish.reason).toBe("end_turn");
        expect(finish.truncationRecoveries).toBe(1);
    });
});

// ── finish signal on a clean stop ───────────────────────────────────

describe("runAgent — finish signal", () => {
    it("returns the real terminal stop_reason with no recoveries on a clean stop", async () => {
        const provider = scriptedProvider([makeMessage([textBlock("done")], "end_turn")]);

        const { finish } = await runAgent(agentDef([]), GO, makeSession(), opts(provider));

        expect(finish).toEqual({
            reason: "end_turn",
            cappedOut: false,
            truncationRecoveries: 0,
        });
    });

    it("reports cappedOut with reason max_iterations on the wrap-up path", async () => {
        const provider = scriptedProvider((callIndex, request) =>
            request.tools !== undefined && request.tools.length === 0
                ? makeMessage([textBlock("reached")], "end_turn")
                : makeMessage([toolUseBlock(`tu-${callIndex}`, "echo", { label: "x" })], "tool_use"),
        );

        const { finish } = await runAgent(agentDef([echoTool()], 3), GO, makeSession(), opts(provider));

        expect(finish.cappedOut).toBe(true);
        expect(finish.reason).toBe("max_iterations");
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
