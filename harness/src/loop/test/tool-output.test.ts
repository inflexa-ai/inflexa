import { describe, expect, it } from "bun:test";
import { hasLoneHighSurrogate, hasLoneLowSurrogate, isToolOutputRef, referencedToolOutput } from "../../lib/test/text-shapes.js";
import type { ModelMessage, ToolResultPart } from "ai";
import { errAsync, ok, okAsync } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { presentAt, presentFirst } from "../../lib/present.js";
import type { AgentSession } from "../../auth/types.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { defineTool, withToolResultImage, type Tool } from "../../tools/define-tool.js";
import { createReadToolOutputTool } from "../../tools/read-tool-output.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { continueLoop, runLoop, type LoopOptions } from "../run-loop.js";
import {
    EXCERPT_HEAD_CHARS,
    EXCERPT_TAIL_CHARS,
    READ_TOOL_OUTPUT_TOOL_ID,
    TOOL_OUTPUT_KEEP_MAX,
    TOOL_RESULT_CAP,
    type KeptToolOutput,
    type ToolOutputStore,
} from "../tool-output.js";
import type { AgentDefinition, EmitEvent } from "../types.js";

const GO: ReadonlyArray<{ role: "user"; content: string }> = [{ role: "user", content: "go" }];

function agentDef(tools: Tool[]): AgentDefinition {
    return { id: "test-agent", systemPrompt: "You are a test agent.", model: "claude-test", tools, maxIterations: 8 };
}

function opts(script: readonly ScriptStep[], overrides: Partial<LoopOptions> = {}): LoopOptions {
    return { provider: scriptedModel(script).provider, signal: new AbortController().signal, emit: () => {}, ...overrides };
}

type MemoryStore = ToolOutputStore & {
    readonly puts: KeptToolOutput[];
};

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
    view: "none",
    describeCall: "none",
    execute: () => Promise.resolve(ok({ status: "not_found" })),
});

/** A deterministic text of `length` characters, thus a test can find each part of an excerpt. */
function fill(length: number): string {
    let text = "";
    for (let i = 0; text.length < length; i++) text += `${i.toString(36)},`;
    return text.slice(0, length);
}

/** A tool whose ok value is a string with a JSON text of exactly `length` characters. */
function sizedTool(): Tool {
    return defineTool({
        id: "big",
        description: "Give a text of a length.",
        inputSchema: z.object({ length: z.number().int() }),
        view: "none",
        describeCall: "none",
        execute: ({ length }) => Promise.resolve(ok(fill(length - 2))),
    });
}

/** The JSON text that `sizedTool` gives for `length`. */
function sizedText(length: number): string {
    return JSON.stringify(fill(length - 2));
}

function callBig(length: number, id = "tu-1"): ScriptStep[] {
    return [callTools(toolCall(id, "big", { length })), reply([text("done")])];
}

/** The text of the first tool result that a request sent. */
function promptResultText(call: LanguageModelV4CallOptions): string {
    for (const message of call.prompt) {
        if (message.role !== "tool") continue;
        for (const part of message.content) {
            if (part.type !== "tool-result") continue;
            if (part.output.type === "text" || part.output.type === "error-text") return part.output.value;
        }
    }
    throw new Error("the request carries no text tool result");
}

function onlyResult(messages: readonly ModelMessage[]): ToolResultPart {
    const tool = messages.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    if (tool === undefined) throw new Error("the tool message is absent");
    const content = tool.content;
    if (typeof content === "string") throw new Error("the tool message carries string content");
    const results = content.flatMap((part) => (part.type === "tool-result" ? [part] : []));
    return presentFirst(results);
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

describe("runLoop — long tool results", () => {
    it("gives a result of exactly the cap back as the json result with no change", async () => {
        const store = memoryStore();

        const { messages } = await runLoop(
            agentDef([sizedTool(), readToolStub]),
            GO,
            makeSession(),
            opts(callBig(TOOL_RESULT_CAP), { toolOutputStore: store }),
        );

        expect(onlyResult(messages).output).toEqual({ type: "json", value: fill(TOOL_RESULT_CAP - 2) });
        expect(store.puts).toHaveLength(0);
    });

    it("cuts a result one character over the cap into a text excerpt: the first line, the reference line, the start, the marker line, and the end", async () => {
        const length = TOOL_RESULT_CAP + 1;
        const text = sizedText(length);
        const store = memoryStore();

        const { messages } = await runLoop(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(callBig(length), { toolOutputStore: store }));

        const result = onlyResult(messages);
        expect(result.output.type).toBe("text");
        const ref = presentFirst(store.puts).ref;
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
            view: "none",
            describeCall: "none",
            execute: () => {
                return Promise.reject(new Error("E".repeat(50_000)));
            },
        });
        const { messages } = await runLoop(
            agentDef([thrower]),
            GO,
            makeSession(),
            opts([callTools(toolCall("tu-1", "thrower", {})), reply([text("done")])], {
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
            view: "none",
            describeCall: "none",
            execute: () => Promise.resolve(ok(withToolResultImage({ text: fill(40_000) }, { base64: "PNGBYTES", mediaType: "image/png" }))),
        });
        const { provider } = scriptedModel([callTools(toolCall("tu-1", "eyes", {})), reply([text("done")])], { capabilities: { imageToolResults: true } });

        const { messages } = await runLoop(agentDef([eyes]), GO, makeSession(), opts([], { provider }));

        const output = onlyResult(messages).output;
        if (output.type !== "content") throw new Error("the result carries no content output");
        const parts = output.value;
        expect(parts).toHaveLength(2);
        expect(parts[0]).toMatchObject({ type: "text" });
        const first = parts[0];
        if (first === undefined || !("text" in first)) throw new Error("the first part is not text");
        expect(first.text.startsWith("[Tool result cut: ")).toBe(true);
        expect(parts[1]).toEqual({ type: "file", mediaType: "image/png", data: { type: "data", data: "PNGBYTES" } });
    });

    it("puts the analysis id, a short reference, the whole text, and its length in the store", async () => {
        const length = 100_000;
        const store = memoryStore();

        const { messages } = await runLoop(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(callBig(length), { toolOutputStore: store }));

        expect(store.puts).toHaveLength(1);
        const kept = presentFirst(store.puts);
        expect(kept).toMatchObject({ analysisId: "analysis-001", toolName: "big", toolCallId: "tu-1", totalLength: length });
        expect(isToolOutputRef(kept.ref)).toBe(true);
        expect(kept.content).toBe(sizedText(length));
        expect(textOf(onlyResult(messages)).split("\n")[1]).toContain(`reference "${kept.ref}"`);
    });

    it("names the thread of a chat session, and no thread for a run session with a thread in its scope", async () => {
        const scope = { kind: "analysis" as const, analysisId: "analysis-001", threadId: "t-1" };
        const chatStore = memoryStore();
        const runStore = memoryStore();
        const agent = agentDef([sizedTool(), readToolStub]);

        await runLoop(agent, GO, makeSession({ scope }), opts(callBig(40_000), { toolOutputStore: chatStore }));
        await runLoop(agent, GO, runSession(scope), opts(callBig(40_000), { toolOutputStore: runStore }));

        expect(presentFirst(chatStore.puts).threadId).toBe("t-1");
        expect(presentFirst(runStore.puts).threadId).toBeUndefined();
    });

    it("puts the record before the next model request", async () => {
        const store = memoryStore();
        let keptAtSecondRequest: number | undefined;
        const script: ScriptStep[] = [
            callTools(toolCall("tu-1", "big", { length: 40_000 })),
            () => {
                keptAtSecondRequest = store.puts.length;
                return reply([text("done")]);
            },
        ];

        await runLoop(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(script, { toolOutputStore: store }));

        expect(keptAtSecondRequest).toBe(1);
    });

    it("states that the rest is not kept, with no reference line, when the run has no store", async () => {
        const length = 262_200;
        const text = sizedText(length);

        const { messages } = await runLoop(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(callBig(length)));

        expect(textOf(onlyResult(messages)).split("\n")).toEqual([
            `[Tool result cut: ${length} characters, over the limit of ${TOOL_RESULT_CAP}. Shown: the first ${EXCERPT_HEAD_CHARS} and the last ${EXCERPT_TAIL_CHARS} characters. The rest is not kept.]`,
            text.slice(0, EXCERPT_HEAD_CHARS),
            "[... 249912 characters not shown ...]",
            text.slice(-EXCERPT_TAIL_CHARS),
        ]);
    });

    it("keeps nothing for an agent that does not declare read_tool_output, and gives the excerpt of a run with no store", async () => {
        const store = memoryStore();
        const withStore = await runLoop(agentDef([sizedTool()]), GO, makeSession(), opts(callBig(40_000), { toolOutputStore: store }));
        const noStore = await runLoop(agentDef([sizedTool()]), GO, makeSession(), opts(callBig(40_000)));

        expect(store.puts).toHaveLength(0);
        expect(textOf(onlyResult(withStore.messages))).toBe(textOf(onlyResult(noStore.messages)));
    });

    it("gives the same excerpt when the put fails, and logs one warn", async () => {
        const logger = createCapturingLogger();
        const agent = agentDef([sizedTool(), readToolStub]);

        const working = await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: memoryStore() }));
        const failing = await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: memoryStore("err"), logger }));

        expect(textOf(onlyResult(failing.messages))).toBe(textOf(onlyResult(working.messages)));
        const warns = logger.records.filter((r) => r.level === "warn" && r.msg.includes("tool output not kept"));
        expect(warns).toHaveLength(1);
        expect(presentFirst(warns).fields).toMatchObject({ toolName: "big", toolCallId: "tu-1", errorType: "mutation_failed" });
        expect(failing.finish.reason).toBe("stop");
    });

    it("gives the same reference to two runs of one script under one run frame", async () => {
        const first = memoryStore();
        const second = memoryStore();
        const agent = agentDef([sizedTool(), readToolStub]);

        await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: first }));
        await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: second }));

        expect(presentFirst(second.puts).ref).toBe(presentFirst(first.puts).ref);
    });

    it("puts the same record again when a call runs again under one run frame", async () => {
        const store = memoryStore();
        const agent = agentDef([sizedTool(), readToolStub]);

        const first = await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: store }));
        const replay = await runLoop(agent, GO, runSession(), opts(callBig(40_000), { toolOutputStore: store }));

        expect(store.puts).toHaveLength(2);
        expect(store.puts[1]).toEqual(presentFirst(store.puts));
        expect(textOf(onlyResult(replay.messages))).toBe(textOf(onlyResult(first.messages)));
    });

    it("cuts a long result of a continuation with the store of its options", async () => {
        const agent = agentDef([sizedTool(), readToolStub]);
        const first = await runLoop(agent, GO, makeSession(), opts([reply([text("done")])]));
        const store = memoryStore();

        const continued = await continueLoop(
            agent,
            first.messages,
            { text: "Read the long file.", mask: { allow: ["big"] }, maxRequests: 4 },
            makeSession(),
            opts(callBig(40_000, "tu-c"), { toolOutputStore: store }),
        );

        expect(textOf(onlyResult(continued.messages)).startsWith("[Tool result cut: ")).toBe(true);
        expect(store.puts.map((kept) => kept.toolCallId)).toEqual(["tu-c"]);
    });

    it("keeps the first half, a marker line, and the last half of a text over the maximum of the store", async () => {
        const length = 3_000_000;
        const text = sizedText(length);
        const store = memoryStore();

        await runLoop(agentDef([sizedTool(), readToolStub]), GO, makeSession(), opts(callBig(length), { toolOutputStore: store }));

        const kept = presentFirst(store.puts);
        const half = TOOL_OUTPUT_KEEP_MAX / 2;
        expect(kept.totalLength).toBe(length);
        expect(kept.content).toBe(`${text.slice(0, half)}\n[... ${length - 2 * half} characters not kept ...]\n${text.slice(-half)}`);
    });

    it("keeps a surrogate pair whole at each cut point", async () => {
        const length = 40_000;
        // The JSON text starts with a quote, thus index `i` of the value is index `i + 1` of the text.
        const chars = Array.from(fill(length - 2));
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
            view: "none",
            describeCall: "none",
            execute: () => Promise.resolve(ok(value)),
        });

        const { messages } = await runLoop(agentDef([emojiTool]), GO, makeSession(), opts(callBig(length)));

        const excerpt = textOf(onlyResult(messages));
        expect(excerpt.split("\n")[0]).toContain(`Shown: the first ${EXCERPT_HEAD_CHARS - 1} and the last ${EXCERPT_TAIL_CHARS - 1} characters.`);
        expect(hasLoneHighSurrogate(excerpt) || hasLoneLowSurrogate(excerpt)).toBe(false);
    });

    it("gives the result of read_tool_output uncut when the model reads the reference of its own excerpt", async () => {
        const store = memoryStore();
        const script: ScriptStep[] = [
            callTools(toolCall("tu-1", "big", { length: 100_000 })),
            (call) => {
                const ref = referencedToolOutput(promptResultText(call));
                if (ref === undefined) throw new Error("the excerpt names no stored tool output");
                return callTools(toolCall("tu-2", "read_tool_output", { ref, limit: 16_384 }));
            },
            reply([text("done")]),
        ];

        const { messages } = await runLoop(
            agentDef([sizedTool(), createReadToolOutputTool(store)]),
            GO,
            makeSession(),
            opts(script, { toolOutputStore: store }),
        );

        const toolMessages = messages.filter((m) => m.role === "tool");
        const readContent = presentAt(toolMessages, 1).content;
        if (typeof readContent === "string") throw new Error("the tool message carries string content");
        const read = presentFirst(readContent.flatMap((part) => (part.type === "tool-result" ? [part] : [])));
        if (read.output.type !== "json") throw new Error("the result carries no json output");
        expect(read.output.value).toMatchObject({
            status: "ok",
            offset: 0,
            end: 16_384,
            more: true,
            text: sizedText(100_000).slice(0, 16_384),
        });
        expect(store.puts).toHaveLength(1);
    });
});
