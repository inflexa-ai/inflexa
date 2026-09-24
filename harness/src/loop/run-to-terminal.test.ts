import { describe, expect, it } from "bun:test";
import type { ToolResultPart } from "ai";
import { ok } from "neverthrow";
import { z } from "zod";

import { isSyntheticUserMessage } from "../memory/ai-sdk-message-storage.js";
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

function countedTool(id: string): { tool: Tool; runs: () => number } {
    let runs = 0;
    const tool = defineTool({
        id,
        description: `The ${id} tool.`,
        inputSchema: z.object({}),
        describeCall: "none",
        execute: async () => {
            runs++;
            return ok({ ran: id });
        },
    });
    return { tool, runs: () => runs };
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
                toolChoice: "auto",
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
        expect(provider.calls[0]!.toolChoice).toBe("auto");
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
        expect(names).toEqual(["llm-0", "salvage:llm-0", "salvage:tool-submit-t1"]);
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

    it("declares each tool of the agent on each salvage request", async () => {
        const cell = { value: null as string | null };
        const submit = submitTool(cell);
        const blocker = countedTool("report_blocker");
        const agent = agentDef([countedTool("search").tool, countedTool("read").tool, submit, blocker.tool]);
        const provider = scriptedProvider([
            makeMessage([textBlock("thinking")], "end_turn"),
            makeMessage([toolUseBlock("t1", "submit", { answer: "salvaged" })], "tool_use"),
        ]);

        const { messages, salvage } = await runToTerminal(
            agent,
            GO,
            makeSession(),
            { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep, resolved: () => cell.value !== null },
            { tools: [submit, blocker.tool], nudge: NUDGE },
        );

        expect(cell.value).toBe("salvaged");
        expect(provider.calls).toHaveLength(2);
        const [firstRequest, salvageRequest] = provider.calls;
        expect(Object.keys(salvageRequest!.tools)).toEqual(["search", "read", "submit", "report_blocker"]);
        expect(Object.keys(salvageRequest!.tools)).toEqual(Object.keys(firstRequest!.tools));
        expect(salvageRequest!.system).toEqual(firstRequest!.system);
        // The nudge is a synthetic request, thus it opens no turn in a stored thread.
        const nudge = messages[2]!;
        expect(nudge.content).toBe(NUDGE);
        expect(isSyntheticUserMessage(nudge)).toBe(true);
        expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "tool"]);
        expect(salvage?.firstFinish.reason).toBe("stop");
    });

    it("refuses a salvage call of a tool that is not terminal", async () => {
        const cell = { value: null as string | null };
        const submit = submitTool(cell);
        const search = countedTool("search");
        const provider = scriptedProvider([
            makeMessage([textBlock("thinking")], "end_turn"),
            makeMessage([toolUseBlock("s1", "search", {})], "tool_use"),
            makeMessage([toolUseBlock("t1", "submit", { answer: "salvaged" })], "tool_use"),
        ]);

        const { messages } = await runToTerminal(
            agentDef([search.tool, submit]),
            GO,
            makeSession(),
            { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep, resolved: () => cell.value !== null },
            { tools: [submit], nudge: NUDGE },
        );

        expect(search.runs()).toBe(0);
        expect(cell.value).toBe("salvaged");
        const refused = messages.flatMap((m) => (m.role === "tool" ? (m.content as ToolResultPart[]) : [])).find((r) => r.toolCallId === "s1")!;
        expect(refused.output.type).toBe("error-text");
        expect(JSON.parse((refused.output as { value: string }).value)).toEqual({
            error: "The tool search is not available for this request, thus it did not run. The tools that can run now: submit.",
            retryable: false,
        });
    });

    it("throws before the first run when a terminal tool is not a declared tool of the agent", async () => {
        const cell = { value: null as string | null };
        const provider = scriptedProvider([makeMessage([textBlock("thinking")], "end_turn")]);

        const run = runToTerminal(
            agentDef([countedTool("search").tool]),
            GO,
            makeSession(),
            { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep, resolved: () => cell.value !== null },
            { tools: [submitTool(cell)], nudge: NUDGE },
        );

        await expect(run).rejects.toThrow('The terminal tool "submit" is not a declared tool of the agent "test-agent"');
        expect(provider.calls).toHaveLength(0);
    });
});
