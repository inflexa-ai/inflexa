import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { ok } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { withRequestInputTokens } from "../../memory/ai-sdk-message-storage.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import { defineTool } from "../../tools/define-tool.js";
import { rulesForContextWindow, type CompactionPolicy } from "../compaction.js";
import { continueLoop, runLoop, type LoopOptions } from "../run-loop.js";
import type { AgentDefinition, EmitFn, LoopMessage } from "../types.js";

describe("rulesForContextWindow", () => {
    const rules = { turnStartBudget: 150_000, budget: 200_000 };

    it("keeps the declared rules when the window is absent or 80% of it is at least the budget", () => {
        expect(rulesForContextWindow(rules, undefined)).toBe(rules);
        expect(rulesForContextWindow(rules, 1_000_000)).toBe(rules);
        expect(rulesForContextWindow(rules, 250_000)).toBe(rules);
    });

    it("caps the budget at 80% of a smaller window, and keeps the ratio of the turn-start budget", () => {
        expect(rulesForContextWindow(rules, 40_960)).toEqual({ budget: 32_768, turnStartBudget: 24_576 });
    });

    it("caps a budget with no turn-start budget", () => {
        expect(rulesForContextWindow({ budget: 250_000 }, 128_000)).toEqual({ budget: 102_400 });
    });
});

const echo = defineTool({
    id: "echo",
    description: "Echo the text.",
    inputSchema: z.object({ text: z.string() }),
    view: "none",
    describeCall: "none",
    execute: (input) => Promise.resolve(ok({ echoed: input.text })),
});

const agent: AgentDefinition = { id: "chat-agent", systemPrompt: "You are a test agent.", model: "scripted-model", tools: [echo], maxIterations: 5 };

const COMPACT_REQUEST = "Summarize the conversation.";

function policy(rules: { readonly budget: number; readonly turnStartBudget?: number }): CompactionPolicy {
    return { ...rules, request: COMPACT_REQUEST, mask: "none", keepFirstTurn: false, recordsAfter: () => Promise.resolve([]) };
}

const user = (content: string): LoopMessage => ({ role: "user", content });

function textsOf(call: LanguageModelV4CallOptions | undefined): string[] {
    return (call?.prompt ?? []).flatMap((message) => {
        if (message.role === "system") return [];
        return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
    });
}

type Emitted = Parameters<EmitFn>[0];

const CompactionDataSchema = z.looseObject({ id: z.string(), status: z.string(), tokensBefore: z.number(), trigger: z.string().optional() });

function compactionParts(events: readonly Emitted[]): z.infer<typeof CompactionDataSchema>[] {
    return events.flatMap((event) => (event.type === "data-compaction" && "data" in event ? [CompactionDataSchema.parse(event.data)] : []));
}

function loopOptions(
    script: readonly ScriptStep[],
    extra: Partial<LoopOptions> = {},
): { readonly opts: LoopOptions; readonly calls: LanguageModelV4CallOptions[]; readonly events: Emitted[] } {
    const { provider, calls } = scriptedModel(script);
    const events: Emitted[] = [];
    const opts: LoopOptions = {
        provider,
        signal: new AbortController().signal,
        emit: (event) => {
            events.push(event);
        },
        promptCache: "off",
        ...extra,
    };
    return { opts, calls, events };
}

describe("runLoop — compaction", () => {
    it("compacts between two rounds when the last request passed the budget, and the next request sends the new view", async () => {
        const { opts, calls, events } = loopOptions(
            [
                { ...callTools(toolCall("c1", "echo", { text: "a" })), usage: { inputTokens: 900, outputTokens: 10 } },
                reply([text("SUMMARY")]),
                reply([text("done")]),
            ],
            { compaction: policy({ budget: 500 }) },
        );

        const result = await runLoop(agent, [user("go")], makeSession(), opts);

        expect(result.finish.reason).toBe("stop");
        expect(textsOf(calls[1]).at(-1)).toBe(COMPACT_REQUEST);
        expect(textsOf(calls[2])).toEqual(["[Conversation Summary]\nSUMMARY"]);
        const [running, done] = compactionParts(events);
        expect(running).toMatchObject({ status: "running", trigger: "mid-turn", tokensBefore: 900 });
        expect(done).toMatchObject({ status: "done", trigger: "mid-turn", tokensBefore: 900, id: running?.id });
    });

    it("does not compact in a follow-up request", async () => {
        const conversation = [user("go"), withRequestInputTokens({ role: "assistant", content: "earlier reply" }, 900)];
        const { opts, calls, events } = loopOptions([reply([text("summary of the step")])], { compaction: policy({ budget: 500 }) });

        await continueLoop(agent, conversation, { text: "Write the summary.", mask: "none", maxRequests: 1 }, makeSession(), opts);

        expect(calls).toHaveLength(1);
        expect(compactionParts(events)).toEqual([]);
    });

    it("keeps the view when the provider refuses the exchange, and logs one error with the status", async () => {
        const logger = createCapturingLogger();
        const refused = new APICallError({
            message: "request too large",
            url: "https://model.test",
            requestBodyValues: {},
            statusCode: 413,
            isRetryable: false,
        });
        const { opts, calls, events } = loopOptions(
            [{ ...callTools(toolCall("c1", "echo", { text: "a" })), usage: { inputTokens: 900, outputTokens: 10 } }, { fail: refused }, reply([text("done")])],
            { compaction: policy({ budget: 500 }), logger },
        );

        const result = await runLoop(agent, [user("go")], makeSession(), opts);

        expect(result.finish.reason).toBe("stop");
        expect(calls[2]?.prompt).toEqual(calls[1]?.prompt.slice(0, -1));
        expect(compactionParts(events)).toMatchObject([{ status: "running" }, { status: "failed" }]);
        const errors = logger.records.filter((record) => record.level === "error");
        expect(errors).toHaveLength(1);
        expect(errors[0]?.fields).toMatchObject({ status: 413 });
    });

    it("compacts before the input of a turn joins the conversation", async () => {
        const initial = [user("old question"), withRequestInputTokens({ role: "assistant", content: "old answer" }, 900)];
        const { opts, calls, events } = loopOptions([reply([text("SUMMARY")]), reply([text("answer")])], {
            compaction: policy({ budget: 10_000, turnStartBudget: 500 }),
            turnInput: [user("new question")],
        });

        const result = await runLoop(agent, initial, makeSession(), opts);

        expect(textsOf(calls[0])).toEqual(["old question", "old answer", COMPACT_REQUEST]);
        expect(textsOf(calls[1])).toEqual(["[Conversation Summary]\nSUMMARY", "new question"]);
        expect(compactionParts(events)).toMatchObject([
            { status: "running", trigger: "turn-start" },
            { status: "done", trigger: "turn-start" },
        ]);
        expect(result.finish.reason).toBe("stop");
    });

    it("ends the run as aborted when an abort stops the turn-start compaction, and the input does not join", async () => {
        const controller = new AbortController();
        const abort = new DOMException("The user stopped the turn.", "AbortError");
        const initial = [user("old question"), withRequestInputTokens({ role: "assistant", content: "old answer" }, 900)];
        const { opts } = loopOptions(
            [
                () => {
                    controller.abort(abort);
                    return { fail: abort };
                },
            ],
            { compaction: policy({ budget: 10_000, turnStartBudget: 500 }), turnInput: [user("new question")], signal: controller.signal },
        );

        const result = await runLoop(agent, initial, makeSession(), opts);

        expect(result.finish.reason).toBe("aborted");
        expect(result.messages.some((message) => message.role === "user" && message.content === "new question")).toBe(false);
    });
});
