import { describe, expect, it } from "bun:test";
import type { ModelMessage, ToolResultPart } from "ai";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../__tests__/setup/logger.js";
import type { AgentSession } from "../auth/types.js";
import { makeSession } from "../providers/__fixtures__/session.js";
import type { ChatResponse } from "../providers/types.js";
import { defineTool, withToolResultImage, type Tool } from "../tools/define-tool.js";
import { makeMessage, scriptedProvider, textBlock, toolUseBlock, type ScriptedProvider } from "./__fixtures__/scripted-provider.js";
import { continueAgent } from "./continue-agent.js";
import { runAgent, type RunAgentOptions } from "./run-agent.js";
import { passthroughStep } from "./run-step.js";
import {
    EXCERPT_HEAD_CHARS,
    EXCERPT_TAIL_CHARS,
    READ_TOOL_OUTPUT_TOOL_ID,
    TOOL_OUTPUT_KEEP_MAX,
    TOOL_RESULT_CAP,
    type KeptToolOutput,
    type ToolOutputStore,
} from "./tool-output.js";
import type { AgentDefinition, EmitEvent, RunStep } from "./types.js";

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

function agentDef(tools: Tool[]): AgentDefinition {
    return { id: "test-agent", systemPrompt: "You are a test agent.", model: "claude-test", tools, maxIterations: 8 };
}

function opts(provider: ScriptedProvider, overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return { provider, signal: new AbortController().signal, emit: () => {}, runStep: passthroughStep, ...overrides };
}

interface MemoryStore extends ToolOutputStore {
    readonly puts: KeptToolOutput[];
}

function memoryStore(outcome: "ok" | "err" = "ok"): MemoryStore {
    const puts: KeptToolOutput[] = [];
    return {
        puts,
        put: (output) => {
            puts.push(output);
            return outcome === "ok" ? okAsync(undefined) : errAsync({ type: "mutation_failed" });
        },
        get: (analysisId, ref) => okAsync([...puts].reverse().find((kept) => kept.analysisId === analysisId && kept.ref === ref) ?? null),
    };
}

/** A tool with the id of the read tool. The loop keeps a text only for an agent that declares it. */
const readToolStub: Tool = defineTool({
    id: READ_TOOL_OUTPUT_TOOL_ID,
    description: "Read a kept text.",
    inputSchema: z.object({ ref: z.string() }),
    describeCall: "none",
    execute: async () => ok({ status: "not_found" }),
});

/** A deterministic text of `length` characters, thus a test can find each part of an excerpt. */
function fill(length: number): string {
    let text = "";
    for (let i = 0; text.length < length; i++) text += `${i.toString(36)},`;
    return text.slice(0, length);
}

/** A tool whose ok value is a string with a JSON text of exactly `length` characters. */
function sizedTool(executionMode: "step" | "workflow" = "step"): Tool {
    return defineTool({
        id: "big",
        description: "Give a text of a length.",
        executionMode,
        inputSchema: z.object({ length: z.number().int() }),
        describeCall: "none",
        execute: async ({ length }) => ok(fill(length - 2)),
    });
}

/** The JSON text that `sizedTool` gives for `length`. */
function sizedText(length: number): string {
    return JSON.stringify(fill(length - 2));
}

function callBig(length: number, id = "tu-1"): ChatResponse[] {
    return [makeMessage([toolUseBlock(id, "big", { length })], "tool_use"), makeMessage([textBlock("done")], "end_turn")];
}

function onlyResult(messages: readonly ModelMessage[]): ToolResultPart {
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    return (tool!.content as ToolResultPart[])[0]!;
}

function textOf(result: ToolResultPart): string {
    const { output } = result;
    if (output.type !== "text" && output.type !== "error-text") throw new Error(`expected a text output, got ${output.type}`);
    return output.value;
}

const runSession = (scope: AgentSession["scope"] = { kind: "analysis", analysisId: "analysis-001" }): AgentSession => ({
    ...makeSession({ scope }),
    runFrame: { runId: "run-1", stepId: "T1S1" },
});

describe("runAgent — long tool results", () => {
    it("gives a result of exactly the cap back as the json result with no change", async () => {
        const store = memoryStore();

        const { messages } = await runAgent(
            agentDef([sizedTool(), readToolStub]),
            GO,
            makeSession(),
            opts(scriptedProvider(callBig(TOOL_RESULT_CAP)), { toolOutputStore: store }),
        );

        expect(onlyResult(messages).output).toEqual({ type: "json", value: fill(TOOL_RESULT_CAP - 2) });
        expect(store.puts).toHaveLength(0);
    });

    it("cuts a result one character over the cap into a text excerpt: the first line, the reference line, the start, the marker line, and the end", async () => {
        const length = TOOL_RESULT_CAP + 1;
        const text = sizedText(length);
        const store = memoryStore();

        const { messages } = await runAgent(
            agentDef([sizedTool(), readToolStub]),
            GO,
            makeSession(),
            opts(scriptedProvider(callBig(length)), { toolOutputStore: store }),
        );

        const result = onlyResult(messages);
        expect(result.output.type).toBe("text");
        const ref = store.puts[0]!.ref;
        expect(textOf(result).split("\n")).toEqual([
            `[Tool result cut: ${length} characters, over the limit of ${TOOL_RESULT_CAP}. Shown: the first ${EXCERPT_HEAD_CHARS} and the last ${EXCERPT_TAIL_CHARS} characters.]`,
            `[The harness kept ${length} characters as reference "${ref}". Call read_tool_output with this reference and an offset and a limit, or with a pattern. Offsets start at 0.]`,
            text.slice(0, EXCERPT_HEAD_CHARS),
            `[... ${length - EXCERPT_HEAD_CHARS - EXCERPT_TAIL_CHARS} characters not shown ...]`,
            text.slice(-EXCERPT_TAIL_CHARS),
        ]);
    });

    it("cuts a thrown error into an error-text excerpt, and tool-finished reports an error", async () => {
        const finished: EmitEvent[] = [];
        const thrower = defineTool({
            id: "thrower",
            description: "Fail with a long message.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => {
                throw new Error("E".repeat(50_000));
            },
        });
        const provider = scriptedProvider([makeMessage([toolUseBlock("tu-1", "thrower", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]);

        const { messages } = await runAgent(
            agentDef([thrower]),
            GO,
            makeSession(),
            opts(provider, {
                emit: (event) => {
                    if (event.type === "tool-finished") finished.push(event);
                },
            }),
        );

        const result = onlyResult(messages);
        expect(result.output.type).toBe("error-text");
        expect(textOf(result).startsWith("[Tool result cut: ")).toBe(true);
        expect(finished).toHaveLength(1);
        expect(finished[0]).toMatchObject({ outcome: "error" });
    });

    it("keeps the file part of a result with a picture after the excerpt", async () => {
        const eyes = defineTool({
            id: "eyes",
            description: "Give a picture beside a long text.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async () => ok(withToolResultImage({ text: fill(40_000) }, { base64: "PNGBYTES", mediaType: "image/png" })),
        });
        const provider: ScriptedProvider = {
            ...scriptedProvider([makeMessage([toolUseBlock("tu-1", "eyes", {})], "tool_use"), makeMessage([textBlock("done")], "end_turn")]),
            capabilities: { toolCalling: true, imageToolResults: true },
        };

        const { messages } = await runAgent(agentDef([eyes]), GO, makeSession(), opts(provider));

        const output = onlyResult(messages).output;
        expect(output.type).toBe("content");
        const parts = (output as Extract<ToolResultPart["output"], { type: "content" }>).value;
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatchObject({ type: "text" });
        expect((parts[0] as { text: string }).text.startsWith("[Tool result cut: ")).toBe(true);
        expect(parts[1]).toEqual({ type: "file", mediaType: "image/png", data: { type: "data", data: "PNGBYTES" } });
    });

    it("puts the analysis id, a short reference, the whole text, and its length in the store", async () => {
        const length = 100_000;
        const store = memoryStore();

        const { messages } = await runAgent(
            agentDef([sizedTool(), readToolStub]),
            GO,
            makeSession(),
            opts(scriptedProvider(callBig(length)), { toolOutputStore: store }),
        );

        expect(store.puts).toHaveLength(1);
        const kept = store.puts[0]!;
        expect(kept).toMatchObject({ analysisId: "analysis-001", toolName: "big", toolCallId: "tu-1", totalLength: length });
        expect(kept.ref).toMatch(/^to_[0-9a-f]{20}$/);
        expect(kept.content).toBe(sizedText(length));
        expect(textOf(onlyResult(messages)).split("\n")[1]).toContain(`reference "${kept.ref}"`);
    });

    it("names the thread of a chat session, and no thread for a run session with a thread in its scope", async () => {
        const scope = { kind: "analysis" as const, analysisId: "analysis-001", threadId: "t-1" };
        const chatStore = memoryStore();
        const runStore = memoryStore();
        const agent = agentDef([sizedTool(), readToolStub]);

        await runAgent(agent, GO, makeSession({ scope }), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: chatStore }));
        await runAgent(agent, GO, runSession(scope), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: runStore }));

        expect(chatStore.puts[0]!.threadId).toBe("t-1");
        expect(runStore.puts[0]!).not.toHaveProperty("threadId");
    });

    it("puts the record before the next model request", async () => {
        const store = memoryStore();
        let keptAtSecondRequest: number | undefined;
        const provider = scriptedProvider((i) => {
            if (i === 0) return makeMessage([toolUseBlock("tu-1", "big", { length: 40_000 })], "tool_use");
            keptAtSecondRequest = store.puts.length;
            return makeMessage([textBlock("done")], "end_turn");
        });

        await runAgent(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(provider, { toolOutputStore: store }));

        expect(keptAtSecondRequest).toBe(1);
    });

    it("states that the rest is not kept, with no reference line, when the run has no store", async () => {
        const length = 262_200;
        const text = sizedText(length);

        const { messages } = await runAgent(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(scriptedProvider(callBig(length))));

        expect(textOf(onlyResult(messages)).split("\n")).toEqual([
            `[Tool result cut: ${length} characters, over the limit of ${TOOL_RESULT_CAP}. Shown: the first ${EXCERPT_HEAD_CHARS} and the last ${EXCERPT_TAIL_CHARS} characters. The rest is not kept.]`,
            text.slice(0, EXCERPT_HEAD_CHARS),
            "[... 249912 characters not shown ...]",
            text.slice(-EXCERPT_TAIL_CHARS),
        ]);
    });

    it("keeps nothing for an agent that does not declare read_tool_output, and gives the excerpt of a run with no store", async () => {
        const store = memoryStore();
        const withStore = await runAgent(agentDef([sizedTool()]), GO, makeSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: store }));
        const noStore = await runAgent(agentDef([sizedTool()]), GO, makeSession(), opts(scriptedProvider(callBig(40_000))));

        expect(store.puts).toHaveLength(0);
        expect(textOf(onlyResult(withStore.messages))).toBe(textOf(onlyResult(noStore.messages)));
    });

    it("gives the same excerpt when the put fails, and logs one warn", async () => {
        const logger = createCapturingLogger();
        const agent = agentDef([sizedTool(), readToolStub]);

        const working = await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: memoryStore() }));
        const failing = await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: memoryStore("err"), logger }));

        expect(textOf(onlyResult(failing.messages))).toBe(textOf(onlyResult(working.messages)));
        const warns = logger.records.filter((r) => r.level === "warn" && r.msg.includes("tool output not kept"));
        expect(warns).toHaveLength(1);
        expect(warns[0]!.fields).toMatchObject({ toolName: "big", toolCallId: "tu-1", errorType: "mutation_failed" });
        expect(failing.finish.reason).toBe("stop");
    });

    it("gives the same reference to two runs of one script under one run frame", async () => {
        const first = memoryStore();
        const second = memoryStore();
        const agent = agentDef([sizedTool(), readToolStub]);

        await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: first }));
        await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: second }));

        expect(second.puts[0]!.ref).toBe(first.puts[0]!.ref);
    });

    it("puts the same record again when a workflow-mode tool runs again under one run frame", async () => {
        const store = memoryStore();
        const agent = agentDef([sizedTool("workflow"), readToolStub]);

        const first = await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: store }));
        const replay = await runAgent(agent, GO, runSession(), opts(scriptedProvider(callBig(40_000)), { toolOutputStore: store }));

        expect(store.puts).toHaveLength(2);
        expect(store.puts[1]).toEqual(store.puts[0]!);
        expect(textOf(onlyResult(replay.messages))).toBe(textOf(onlyResult(first.messages)));
    });

    it("gives the excerpt as the output of the durable step of a step-mode tool", async () => {
        const outputs = new Map<string, unknown>();
        const runStep: RunStep = async (name, fn) => {
            const output = await fn();
            outputs.set(name, output);
            return output;
        };

        await runAgent(
            agentDef([sizedTool(), readToolStub]),
            GO,
            runSession(),
            opts(scriptedProvider(callBig(40_000)), { runStep, toolOutputStore: memoryStore() }),
        );

        const stepOutput = outputs.get("tool-big-tu-1") as { result: ToolResultPart };
        expect(stepOutput.result.output.type).toBe("text");
        expect(textOf(stepOutput.result).startsWith("[Tool result cut: ")).toBe(true);
    });

    it("cuts a long result of an earlier call in the round of a truncation", async () => {
        const store = memoryStore();
        const provider = scriptedProvider([
            makeMessage([toolUseBlock("tu-A", "big", { length: 40_000 }), toolUseBlock("tu-B", "big", { length: 10 })], "max_tokens"),
            makeMessage([textBlock("done")], "end_turn"),
        ]);

        const { messages } = await runAgent(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(provider, { toolOutputStore: store }));

        const results = messages.find((m) => m.role === "tool")!.content as ToolResultPart[];
        expect(results.map((r) => r.toolCallId)).toEqual(["tu-A", "tu-B"]);
        expect(textOf(results[0]!).startsWith("[Tool result cut: 40000 characters")).toBe(true);
        expect(store.puts.map((kept) => kept.toolCallId)).toEqual(["tu-A"]);
    });

    it("cuts a long result of a continuation with the store of its options", async () => {
        const agent = agentDef([sizedTool(), readToolStub]);
        const first = await runAgent(agent, GO, makeSession(), opts(scriptedProvider([makeMessage([textBlock("done")], "end_turn")])));
        const store = memoryStore();

        const continued = await continueAgent(
            agent,
            first.messages,
            { text: "Read the long file.", mask: { allow: ["big"] }, maxRequests: 4, stepNamespace: "step-summary" },
            makeSession(),
            opts(scriptedProvider(callBig(40_000, "tu-c")), { toolOutputStore: store }),
        );

        expect(textOf(onlyResult(continued.messages)).startsWith("[Tool result cut: ")).toBe(true);
        expect(store.puts.map((kept) => kept.toolCallId)).toEqual(["tu-c"]);
    });

    it("keeps the first half, a marker line, and the last half of a text over the maximum of the store", async () => {
        const length = 3_000_000;
        const text = sizedText(length);
        const store = memoryStore();

        await runAgent(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(scriptedProvider(callBig(length)), { toolOutputStore: store }));

        const kept = store.puts[0]!;
        const half = TOOL_OUTPUT_KEEP_MAX / 2;
        expect(kept.totalLength).toBe(length);
        expect(kept.content).toBe(`${text.slice(0, half)}\n[... ${length - 2 * half} characters not kept ...]\n${text.slice(-half)}`);
    });

    it("keeps a surrogate pair whole at each cut point", async () => {
        const length = 40_000;
        // The JSON text starts with a quote, thus index `i` of the value is index `i + 1` of the text.
        const chars = [...fill(length - 2)];
        const pairAt = (textIndex: number): void => {
            chars[textIndex - 1] = "\uD83D";
            chars[textIndex] = "\uDE00";
        };
        pairAt(EXCERPT_HEAD_CHARS - 1);
        pairAt(length - EXCERPT_TAIL_CHARS - 1);
        const value = chars.join("");
        const emojiTool = defineTool({
            id: "big",
            description: "Give a text with a surrogate pair at each cut point.",
            inputSchema: z.object({ length: z.number().int() }),
            describeCall: "none",
            execute: async () => ok(value),
        });

        const { messages } = await runAgent(agentDef([emojiTool]), GO, makeSession(), opts(scriptedProvider(callBig(length))));

        const excerpt = textOf(onlyResult(messages));
        expect(excerpt.split("\n")[0]).toContain(`Shown: the first ${EXCERPT_HEAD_CHARS - 1} and the last ${EXCERPT_TAIL_CHARS - 1} characters.`);
        expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(excerpt)).toBe(false);
    });
});
