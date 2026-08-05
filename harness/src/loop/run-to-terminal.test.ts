import { describe, expect, it } from "bun:test";
import { ok } from "neverthrow";
import { z } from "zod";

import { makeSession } from "../providers/__fixtures__/session.js";
import { defineTool, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock } from "./__fixtures__/scripted-provider.js";
import { passthroughStep } from "./run-step.js";
import { runToTerminal } from "./run-to-terminal.js";
import type { AgentDefinition, RunStep } from "./types.js";

const GO = [{ role: "user" as const, content: "go" }];
const NUDGE = "Call submit now.";

/** A submit tool that records into a closure cell. */
function submitTool(cell: { value: string | null }): Tool {
    return defineTool({
        id: "submit",
        description: "Record the final answer.",
        inputSchema: z.object({ answer: z.string() }),
        describeCall: "none",
        execute: async ({ answer }) => {
            cell.value = answer;
            return ok({ accepted: true });
        },
    });
}

function agentDef(tools: Tool[], maxIterations = 4): AgentDefinition {
    return {
        id: "test-agent",
        systemPrompt: "test",
        model: "claude-test",
        tools,
        maxIterations,
    };
}

function recordingStep(): { runStep: RunStep; names: string[] } {
    const names: string[] = [];
    return { runStep: (name, fn) => (names.push(name), fn()), names };
}

describe("runToTerminal", () => {
    it("skips the salvage turn when the first run resolves", async () => {
        const cell = { value: null as string | null };
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("t1", "submit", { answer: "done" })], "tool_use"),
            makeMessage([textBlock("ok")], "end_turn"),
        ]);

        await runToTerminal(
            agentDef([submitTool(cell)]),
            GO,
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
                toolChoice: "required",
                resolved: () => cell.value !== null,
            },
            {
                tools: [submitTool(cell)],
                nudge: NUDGE,
            },
        );

        expect(cell.value).toBe("done");
        // The terminal tool ends the loop itself; no acknowledgement call is
        // spent after the closure outcome is recorded.
        expect(provider.calls).toHaveLength(1);
        expect(provider.calls[0]!.toolChoice).toBe("required");
        // No salvage continuation — the nudge never reaches the provider.
        const sawNudge = provider.calls.some((c) => c.messages.some((m) => m.content === NUDGE));
        expect(sawNudge).toBe(false);
    });

    it("runs a salvage turn that captures the outcome when the first run ends on prose", async () => {
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const isSalvage = last?.role === "user" && typeof last.content === "string" && last.content === NUDGE;
            return isSalvage
                ? makeMessage([toolUseBlock("t1", "submit", { answer: "salvaged" })], "tool_use")
                : makeMessage([textBlock("thinking")], "end_turn");
        });

        await runToTerminal(
            agentDef([tool]),
            GO,
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
                resolved: () => cell.value !== null,
            },
            { tools: [tool], nudge: NUDGE },
        );

        expect(cell.value).toBe("salvaged");
    });

    it("does not salvage when the signal is already aborted", async () => {
        const cell = { value: null as string | null };
        const ac = new AbortController();
        ac.abort();
        const provider = scriptedProvider([makeMessage([textBlock("thinking")], "end_turn")]);

        await runToTerminal(
            agentDef([submitTool(cell)]),
            GO,
            makeSession(),
            {
                provider,
                signal: ac.signal,
                emit: () => {},
                runStep: passthroughStep,
                resolved: () => cell.value !== null,
            },
            { tools: [submitTool(cell)], nudge: NUDGE },
        );

        expect(cell.value).toBeNull();
        expect(provider.calls).toHaveLength(1);
    });

    it("namespaces salvage step names so durable callers do not collide cache keys", async () => {
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        const { runStep, names } = recordingStep();
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const isSalvage = last?.role === "user" && typeof last.content === "string" && last.content === NUDGE;
            return isSalvage ? makeMessage([toolUseBlock("t1", "submit", { answer: "x" })], "tool_use") : makeMessage([textBlock("thinking")], "end_turn");
        });

        await runToTerminal(
            agentDef([tool]),
            GO,
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => {},
                runStep,
                resolved: () => cell.value !== null,
            },
            { tools: [tool], nudge: NUDGE },
        );

        // First run used bare `llm-0`; the salvage run's steps are all prefixed,
        // so no name from the two passes collides.
        expect(names).toContain("llm-0");
        expect(names.some((n) => n.startsWith("salvage:llm-"))).toBe(true);
        expect(new Set(names).size).toBe(names.length);
    });

    it("reports the usage of both passes on the returned finish", async () => {
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const isSalvage = last?.role === "user" && typeof last.content === "string" && last.content === NUDGE;
            return isSalvage
                ? makeMessage([toolUseBlock("t1", "submit", { answer: "salvaged" })], "tool_use", { inputTokens: 3, outputTokens: 1 })
                : makeMessage([textBlock("thinking")], "end_turn", { inputTokens: 10, outputTokens: 4 });
        });

        const { finish } = await runToTerminal(
            agentDef([tool]),
            GO,
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
            },
            { resolved: () => cell.value !== null, tools: [tool], nudge: NUDGE },
        );

        // The salvage continuation is the same logical run, so its rollups cover
        // the first pass's call too — 10 (first run) + 3 (the nudged submit) +
        // 10 (the salvage pass's reply after the tool result).
        expect(finish.usage).toEqual({ inputTokens: 23, outputTokens: 9 });
        expect(finish.turnUsage).toEqual(finish.usage!);
    });

    it("leaves both rollups absent when neither pass reported usage", async () => {
        const cell = { value: null as string | null };
        const tool = submitTool(cell);
        // Both passes run — the first ends on prose, the salvage one submits —
        // and no reply carries usage, so the summed rollups must stay absent
        // rather than collapse to an all-zero `{}` nobody reported.
        const provider = scriptedProvider((_i, request) => {
            const last = request.messages.at(-1);
            const isSalvage = last?.role === "user" && typeof last.content === "string" && last.content === NUDGE;
            return isSalvage
                ? makeMessage([toolUseBlock("t1", "submit", { answer: "salvaged" })], "tool_use")
                : makeMessage([textBlock("thinking")], "end_turn");
        });

        const { finish } = await runToTerminal(
            agentDef([tool]),
            GO,
            makeSession(),
            {
                provider,
                signal: new AbortController().signal,
                emit: () => {},
                runStep: passthroughStep,
            },
            { resolved: () => cell.value !== null, tools: [tool], nudge: NUDGE },
        );

        expect(cell.value).toBe("salvaged");
        expect("usage" in finish).toBe(false);
        expect("turnUsage" in finish).toBe(false);
        expect(finish.usage).toBeUndefined();
        expect(finish.turnUsage).toBeUndefined();
    });
});
