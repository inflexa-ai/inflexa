import { describe, expect, it } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { Error as DBOSErrors } from "@dbos-inc/dbos-sdk";
import { err, ok } from "neverthrow";
import { z } from "zod";

import { createCapturingLogger } from "../../__tests__/setup/logger.js";
import { forSubAgent } from "../../auth/types.js";
import { isInterruptedMessage } from "../../memory/ai-sdk-message-storage.js";
import { modelFailureOf } from "../../providers/errors.js";
import { makeSession } from "../../providers/__fixtures__/session.js";
import { defineTool, withToolCallRecord, withToolResultImages, type Tool } from "../../tools/define-tool.js";
import { callTools, reply, scriptedModel, text, toolCall, type ScriptStep } from "../../testing.js";
import { continueLoop, runLoop, runWithSalvage, type AgentRound, type LoopOptions, type LoopStep } from "../run-loop.js";
import type { AgentDefinition, EmitEvent, EmitFn, LoopMessage } from "../types.js";

function echoTool(calls: string[] = []): Tool {
    return defineTool({
        id: "echo",
        description: "Echo the text.",
        inputSchema: z.object({ text: z.string() }),
        describeCall: (input) => `echo ${input.text}`,
        execute: (input) => {
            calls.push(input.text);
            return Promise.resolve(ok({ echoed: input.text }));
        },
    });
}

function agentWith(tools: readonly Tool[], maxIterations = 5): AgentDefinition {
    return { id: "test-agent", systemPrompt: "You are a test agent.", model: "scripted-model", tools, maxIterations };
}

function recordingEmit(): { readonly emit: EmitFn; readonly events: EmitEvent[] } {
    const events: EmitEvent[] = [];
    return {
        events,
        emit: (event) => {
            if (event.type === "iteration" || event.type === "tool-started" || event.type === "tool-finished" || event.type === "message-start")
                events.push(event);
        },
    };
}

const user = (content: string): LoopMessage => ({ role: "user", content });

/** A tool that records each run, under its own id. */
function namedTool(id: string, runs: string[], execute: () => Promise<unknown> = () => Promise.resolve({ done: id })): Tool {
    return defineTool({
        id,
        description: `The tool ${id}.`,
        inputSchema: z.looseObject({}),
        describeCall: "none",
        execute: async () => {
            runs.push(id);
            return ok(await execute());
        },
    });
}

function toolResultsOf(messages: readonly LoopMessage[]): { readonly toolCallId: string; readonly output: unknown }[] {
    return messages.flatMap((message) =>
        message.role === "tool"
            ? message.content.flatMap((part) => (part.type === "tool-result" ? [{ toolCallId: part.toolCallId, output: part.output }] : []))
            : [],
    );
}

function promptToolResults(call: LanguageModelV4CallOptions | undefined): unknown[] {
    return (call?.prompt ?? []).flatMap((message) =>
        message.role === "tool" ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.output] : [])) : [],
    );
}

function lastPromptUserText(call: LanguageModelV4CallOptions | undefined): string | undefined {
    const last = (call?.prompt ?? []).filter((message) => message.role === "user").at(-1);
    if (last === undefined) return undefined;
    return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function options(provider: LoopOptions["provider"], emit: EmitFn, extra: Partial<LoopOptions> = {}): LoopOptions {
    return { provider, emit, signal: new AbortController().signal, ...extra };
}

describe("runLoop", () => {
    it("runs a round of tool calls, then ends on the text reply", async () => {
        const echoed: string[] = [];
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "echo", { text: "hi" })), reply([text("done")])]);
        const { emit, events } = recordingEmit();

        const result = await runLoop(agentWith([echoTool(echoed)]), [user("go")], makeSession(), options(provider, emit));

        expect(echoed).toEqual(["hi"]);
        expect(result.finish.reason).toBe("stop");
        expect(result.finish.cappedOut).toBe(false);
        expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        const toolMessage = result.messages[2];
        expect(toolMessage?.role === "tool" ? toolMessage.content[0] : undefined).toMatchObject({
            type: "tool-result",
            toolCallId: "c1",
            output: { type: "json", value: { echoed: "hi" } },
        });
        expect(events.map((e) => e.type)).toEqual(["tool-started", "tool-finished", "iteration", "iteration"]);
        expect(events[1]).toMatchObject({ type: "tool-finished", outcome: "ok", detail: "echo hi" });
        expect(calls).toHaveLength(2);
    });

    it("sends the prefix of each request again in the next request", async () => {
        const { provider, calls } = scriptedModel([
            callTools(toolCall("c1", "echo", { text: "a" })),
            callTools(toolCall("c2", "echo", { text: "b" })),
            reply([text("done")]),
        ]);
        const { emit } = recordingEmit();

        await runLoop(agentWith([echoTool()]), [user("go")], makeSession(), options(provider, emit, { promptCache: "off" }));

        for (let i = 1; i < calls.length; i++) {
            const before = calls[i - 1];
            const after = calls[i];
            expect(after?.tools).toEqual(before?.tools);
            expect(after?.prompt.slice(0, before?.prompt.length)).toEqual(before?.prompt ?? []);
        }
    });

    it("refuses a call outside the mask, and the tool does not run", async () => {
        const echoed: string[] = [];
        const { provider } = scriptedModel([callTools(toolCall("c1", "echo", { text: "hi" })), reply([text("done")])]);
        const { emit, events } = recordingEmit();

        const result = await runLoop(agentWith([echoTool(echoed)]), [user("go")], makeSession(), options(provider, emit, { policy: { mask: "none" } }));

        expect(echoed).toEqual([]);
        expect(result.finish.reason).toBe("stop");
        const toolMessage = result.messages[2];
        const part = toolMessage?.role === "tool" ? toolMessage.content[0] : undefined;
        expect(part).toMatchObject({ type: "tool-result", toolCallId: "c1", output: { type: "error-text" } });
        expect(events.filter((e) => e.type === "tool-finished")).toMatchObject([{ outcome: "error" }]);
    });

    it("gives a tool error to the model as an error result, and the run continues", async () => {
        const failing = defineTool({
            id: "fails",
            description: "Fails.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(err({ error: "nope", retryable: false })),
        });
        const { provider } = scriptedModel([callTools(toolCall("c1", "fails", {})), reply([text("done")])]);
        const { emit } = recordingEmit();

        const result = await runLoop(agentWith([failing]), [user("go")], makeSession(), options(provider, emit));

        const toolMessage = result.messages[2];
        expect(toolMessage?.role === "tool" ? toolMessage.content[0] : undefined).toMatchObject({
            output: { type: "error-text", value: JSON.stringify({ error: "nope", retryable: false }) },
        });
        expect(result.finish.reason).toBe("stop");
    });
});

describe("runLoop — the follow-up request", () => {
    it("declares each tool, lets only the masked tools run, and gives back only the new messages", async () => {
        const runs: string[] = [];
        const agent = agentWith([namedTool("echo", runs), namedTool("other", runs)]);
        const { provider, calls } = scriptedModel([
            reply([text("done")]),
            callTools(toolCall("c1", "echo", {}), toolCall("c2", "other", {})),
            reply([text("summary")]),
        ]);
        const { emit } = recordingEmit();
        const first = await runLoop(agent, [user("go")], makeSession(), options(provider, emit));

        const follow = await continueLoop(
            agent,
            first.messages,
            { text: "Summarize the run.", mask: { allow: ["echo"] }, maxRequests: 3 },
            makeSession(),
            options(provider, emit),
        );

        expect(calls[1]?.tools).toEqual(calls[0]?.tools);
        expect(calls[1]?.toolChoice).toEqual(calls[0]?.toolChoice);
        expect(lastPromptUserText(calls[1])).toBe("Summarize the run.");
        expect(runs).toEqual(["echo"]);
        expect(follow.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
        expect(toolResultsOf(follow.messages)).toMatchObject([
            { toolCallId: "c1", output: { type: "json" } },
            { toolCallId: "c2", output: { type: "error-text" } },
        ]);
    });
});

describe("runLoop — the policy", () => {
    it("counts a call of the same round against a budget", async () => {
        const runs: string[] = [];
        const { provider } = scriptedModel([
            callTools(toolCall("c1", "lit", { q: 1 }), toolCall("c2", "lit", { q: 2 })),
            callTools(toolCall("c3", "lit", { q: 3 }), toolCall("c4", "lit", { q: 4 })),
            reply([text("done")]),
        ]);
        const { emit } = recordingEmit();

        const result = await runLoop(
            agentWith([namedTool("lit", runs)]),
            [user("go")],
            makeSession(),
            options(provider, emit, { policy: { budget: { lit: 3 } } }),
        );

        expect(runs).toEqual(["lit", "lit", "lit"]);
        expect(result.steps.flatMap((step) => step.calls.map((call) => call.refused))).toEqual([false, false, false, true]);
        expect(toolResultsOf(result.messages).at(-1)).toMatchObject({ toolCallId: "c4", output: { type: "error-text" } });
    });
});

describe("runLoop — tool failures", () => {
    it("gives a thrown tool error to the next request as an error result", async () => {
        const thrower = defineTool({
            id: "thrower",
            description: "Throws.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.reject(new Error("the disk is full")),
        });
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "thrower", {})), reply([text("done")])]);
        const { emit } = recordingEmit();

        const result = await runLoop(agentWith([thrower]), [user("go")], makeSession(), options(provider, emit));

        expect(result.finish.reason).toBe("stop");
        const [output] = promptToolResults(calls[1]);
        expect(output).toMatchObject({ type: "error-text" });
        expect(JSON.stringify(output)).toContain("the disk is full");
    });

    it("passes the cancel of the workflow out of the loop, and sends no next request", async () => {
        const cancelled = defineTool({
            id: "cancelled",
            description: "Meets a cancel.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.reject(new DBOSErrors.DBOSWorkflowCancelledError("wf-1")),
        });
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "cancelled", {})), reply([text("done")])]);
        const { emit } = recordingEmit();

        const run = runLoop(agentWith([cancelled]), [user("go")], makeSession(), options(provider, emit));
        await expect(run).rejects.toBeInstanceOf(DBOSErrors.DBOSWorkflowCancelledError);
        expect(calls).toHaveLength(1);
    });
});

describe("runLoop — a denial of the user", () => {
    it("completes the sibling calls, records the denial, and sends no next request", async () => {
        const runs: string[] = [];
        const asking = defineTool({
            id: "asking",
            description: "Asks for approval.",
            inputSchema: z.object({}),
            describeCall: "none",
            approval: () => ({ title: "Edit a file", command: "edit notes.md" }),
            execute: () => Promise.resolve(ok({ ran: true })),
        });
        // A second request fails the test: the script holds one reply.
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "echo", {}), toolCall("c2", "asking", {}))]);
        const { emit, events } = recordingEmit();

        const result = await runLoop(
            agentWith([namedTool("echo", runs), asking]),
            [user("go")],
            makeSession(),
            options(provider, emit, { approve: () => Promise.resolve({ kind: "denied", feedback: "not this file" }) }),
        );

        expect(calls).toHaveLength(1);
        expect(runs).toEqual(["echo"]);
        expect(result.finish.reason).toBe("denied");
        expect(toolResultsOf(result.messages)).toMatchObject([
            { toolCallId: "c1", output: { type: "json" } },
            { toolCallId: "c2", output: { type: "execution-denied", reason: "The user rejected this action with the following feedback: not this file" } },
        ]);
        const outcomes = new Map(events.flatMap((e) => (e.type === "tool-finished" ? [[e.name, e.outcome] as const] : [])));
        expect(outcomes).toEqual(
            new Map([
                ["echo", "ok"],
                ["asking", "denied"],
            ]),
        );
    });
});

describe("runLoop — the exits", () => {
    it("answers a call of a reply cut at the output limit with a not-run result, and runs nothing", async () => {
        const runs: string[] = [];
        const { provider } = scriptedModel([reply([text("I will call"), toolCall("c1", "echo", {})], "length")]);
        const { emit } = recordingEmit();

        const result = await runLoop(agentWith([namedTool("echo", runs)]), [user("go")], makeSession(), options(provider, emit));

        expect(runs).toEqual([]);
        expect(result.finish.reason).toBe("length");
        expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
        expect(toolResultsOf(result.messages)).toMatchObject([{ toolCallId: "c1", output: { type: "error-text" } }]);
    });

    it("ends at the step cap with no wrap-up request, each call answered, and the cap reported", async () => {
        const runs: string[] = [];
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "echo", {})), callTools(toolCall("c2", "echo", {}))]);
        const { emit } = recordingEmit();

        const result = await runLoop(agentWith([namedTool("echo", runs)], 2), [user("go")], makeSession(), options(provider, emit));

        expect(calls).toHaveLength(2);
        expect(runs).toEqual(["echo", "echo"]);
        expect(result.finish).toMatchObject({ reason: "max_iterations", cappedOut: true });
        expect(toolResultsOf(result.messages).map((r) => r.toolCallId)).toEqual(["c1", "c2"]);
    });

    it("keeps the partial text of an abort with the interruption marker", async () => {
        const controller = new AbortController();
        const abort = new DOMException("The user stopped the turn.", "AbortError");
        const { provider } = scriptedModel([{ breakAfter: [text("Half of the ans")], error: abort }]);
        const { emit } = recordingEmit();

        const result = await runLoop(
            agentWith([]),
            [user("go")],
            makeSession(),
            options(provider, emit, {
                signal: controller.signal,
                onText: () => controller.abort(abort),
            }),
        );

        expect(result.finish.reason).toBe("aborted");
        const last = result.messages.at(-1);
        expect(last).toMatchObject({ role: "assistant", content: "Half of the ans" });
        expect(last !== undefined && isInterruptedMessage(last)).toBe(true);
    });

    it("adds no message for an abort before any text", async () => {
        const controller = new AbortController();
        const abort = new DOMException("The user stopped the turn.", "AbortError");
        const script: ScriptStep[] = [
            () => {
                controller.abort(abort);
                return { fail: abort };
            },
        ];
        const { provider } = scriptedModel(script);
        const { emit } = recordingEmit();

        const result = await runLoop(agentWith([]), [user("go")], makeSession(), options(provider, emit, { signal: controller.signal }));

        expect(result.finish.reason).toBe("aborted");
        expect(result.messages).toEqual([user("go")]);
    });
});

describe("runLoop — the round sink", () => {
    it("holds a round before the next request goes out", async () => {
        const rounds: AgentRound[] = [];
        let roundsAtSecondRequest = -1;
        const script: ScriptStep[] = [
            callTools(toolCall("c1", "echo", { text: "a" })),
            () => {
                roundsAtSecondRequest = rounds.length;
                return reply([text("done")]);
            },
        ];
        const { provider } = scriptedModel(script);
        const { emit } = recordingEmit();

        await runLoop(
            agentWith([echoTool()]),
            [user("go")],
            makeSession(),
            options(provider, emit, { onRound: (round) => Promise.resolve(void rounds.push(round)) }),
        );

        expect(roundsAtSecondRequest).toBe(1);
        expect(rounds[0]?.messages.map((m) => m.role)).toEqual(["assistant", "tool"]);
        expect(rounds.flatMap((round) => round.messages.map((m) => m.role))).toEqual(["assistant", "tool", "assistant"]);
    });

    it("gives the open round with a not-run result to the sink before a throw", async () => {
        const rounds: AgentRound[] = [];
        const outage = new APICallError({ message: "overloaded", url: "https://model.test", requestBodyValues: {}, statusCode: 529, isRetryable: true });
        const { provider } = scriptedModel([reply([text("partial"), toolCall("c1", "echo", { text: "a" })], "length"), { fail: outage }]);
        const { emit } = recordingEmit();
        const looping = agentWith([echoTool()]);

        await runLoop(looping, [user("go")], makeSession(), options(provider, emit, { onRound: (round) => Promise.resolve(void rounds.push(round)) }));

        expect(rounds.flatMap((round) => round.messages.map((m) => m.role))).toEqual(["assistant", "tool"]);
    });
});

describe("runLoop — tool results", () => {
    it("gives the call record to its tool after the round, and the model never reads it", async () => {
        const folded: unknown[] = [];
        const recording = defineTool({
            id: "recording",
            description: "Records.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () => Promise.resolve(ok(withToolCallRecord({ shown: "yes" }, { lineage: "exec-1" }))),
            foldCallRecord: (record) => {
                folded.push(record);
            },
        });
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "recording", {})), reply([text("done")])]);
        const { emit } = recordingEmit();

        await runLoop(agentWith([recording]), [user("go")], makeSession(), options(provider, emit));

        expect(folded).toEqual([{ lineage: "exec-1" }]);
        expect(promptToolResults(calls[1])).toEqual([{ type: "json", value: { shown: "yes" } }]);
    });

    it("drops the pictures for a wire with no picture in a tool result, and warns with the count", async () => {
        const logger = createCapturingLogger();
        const eyes = defineTool({
            id: "eyes",
            description: "Looks.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: () =>
                Promise.resolve(
                    ok(
                        withToolResultImages({ page: 1 }, [
                            { base64: "AAAA", mediaType: "image/png" },
                            { base64: "BBBB", mediaType: "image/png" },
                        ]),
                    ),
                ),
        });
        const { provider, calls } = scriptedModel([callTools(toolCall("c1", "eyes", {})), reply([text("done")])], {
            capabilities: { imageToolResults: false },
        });
        const { emit } = recordingEmit();

        await runLoop(agentWith([eyes]), [user("go")], makeSession(), options(provider, emit, { logger }));

        expect(promptToolResults(calls[1])).toEqual([{ type: "json", value: { page: 1 } }]);
        const warns = logger.records.filter((r) => r.level === "warn" && r.msg.includes("picture"));
        expect(warns).toHaveLength(1);
        expect(warns[0]?.fields).toMatchObject({ imageCount: 2 });
    });

    it("reports the duration of each of two parallel calls apart", async () => {
        const runs: string[] = [];
        const fast = namedTool("fast", runs, async () => {
            await Bun.sleep(50);
            return { done: "fast" };
        });
        const slow = namedTool("slow", runs, async () => {
            await Bun.sleep(300);
            return { done: "slow" };
        });
        const { provider } = scriptedModel([callTools(toolCall("c1", "fast", {}), toolCall("c2", "slow", {})), reply([text("done")])]);
        const { emit, events } = recordingEmit();

        await runLoop(agentWith([fast, slow]), [user("go")], makeSession(), options(provider, emit));

        const durations = new Map(events.flatMap((e) => (e.type === "tool-finished" ? [[e.name, e.durationMs ?? -1] as const] : [])));
        expect(durations.get("fast")).toBeGreaterThanOrEqual(45);
        expect(durations.get("fast")).toBeLessThan(250);
        expect(durations.get("slow")).toBeGreaterThanOrEqual(295);
    });
});

describe("runLoop — a sub-agent", () => {
    it("runs under a child session, and each event of the child names its call path and the call it runs in", async () => {
        const childEvents: Parameters<EmitFn>[0][] = [];
        const child = agentWith([echoTool()]);
        const childModel = scriptedModel([callTools(toolCall("k1", "echo", { text: "x" })), reply([text("child done")])]);
        const parentTool = defineTool({
            id: "delegate",
            description: "Runs the child.",
            inputSchema: z.object({}),
            describeCall: "none",
            execute: async (_input, ctx) => {
                const result = await runLoop({ ...child, id: "child-agent" }, [user("child task")], forSubAgent(ctx.session, "child-agent"), {
                    provider: childModel.provider,
                    signal: ctx.signal,
                    emit: (event) => {
                        childEvents.push(event);
                    },
                    turnUsage: ctx.turnUsage,
                    invocationId: ctx.invocationId,
                });
                return ok({ reason: result.finish.reason });
            },
        });
        const { provider } = scriptedModel([callTools(toolCall("p1", "delegate", {})), reply([text("done")])]);
        const { emit } = recordingEmit();
        const session = makeSession({ agentId: "root-agent", callPath: ["root-agent"] });

        await runLoop(agentWith([parentTool]), [user("go")], session, options(provider, emit));

        expect(childEvents.length).toBeGreaterThan(0);
        for (const event of childEvents) {
            expect("source" in event ? event.source : undefined).toEqual({
                agentId: "child-agent",
                callPath: ["root-agent", "child-agent"],
                invocationId: "p1",
            });
        }
        expect(session.provenance).toEqual({ agentId: "root-agent", callPath: ["root-agent"] });
    });
});

describe("runWithSalvage", () => {
    const hasSubmission = (steps: readonly LoopStep[]): boolean =>
        steps.some((step) => step.calls.some((call) => call.toolName === "submit" && call.output?.outcome === "ok"));

    it("sends one salvage request after a run that ends on prose, and only the terminal tools run in it", async () => {
        const runs: string[] = [];
        const agent = agentWith([namedTool("search", runs), namedTool("submit", runs)]);
        const { provider, calls } = scriptedModel([
            reply([text("I think the answer is clear.")]),
            callTools(toolCall("s1", "search", {}), toolCall("s2", "submit", {})),
            reply([text("submitted")]),
        ]);
        const { emit } = recordingEmit();

        const result = await runWithSalvage(agent, [user("go")], makeSession(), options(provider, emit), {
            tools: ["submit"],
            nudge: "Submit your answer now.",
            hasOutcome: hasSubmission,
        });

        expect(lastPromptUserText(calls[1])).toBe("Submit your answer now.");
        expect(runs).toEqual(["submit"]);
        expect(result.salvage?.firstFinish.reason).toBe("stop");
        expect(hasSubmission(result.steps)).toBe(true);
        expect(calls[1]?.tools).toEqual(calls[0]?.tools);
    });

    it("sends no salvage request after an aborted run", async () => {
        const controller = new AbortController();
        const abort = new DOMException("The user stopped the run.", "AbortError");
        const { provider, calls } = scriptedModel([{ breakAfter: [text("Thinking")], error: abort }, reply([text("unused")])]);
        const { emit } = recordingEmit();

        const result = await runWithSalvage(
            agentWith([namedTool("submit", [])]),
            [user("go")],
            makeSession(),
            options(provider, emit, { signal: controller.signal, onText: () => controller.abort(abort) }),
            { tools: ["submit"], nudge: "Submit.", hasOutcome: hasSubmission },
        );

        expect(result.finish.reason).toBe("aborted");
        expect(result.salvage).toBeNull();
        expect(calls).toHaveLength(1);
    });
});

describe("the classifier of a failed model call", () => {
    const failing = (status: number, headers: Record<string, string> = {}): APICallError =>
        new APICallError({
            message: `HTTP ${status}`,
            url: "https://model.test",
            requestBodyValues: {},
            statusCode: status,
            responseHeaders: headers,
            isRetryable: status >= 500,
        });

    async function failureOfRun(script: readonly ScriptStep[], maxRetries = 0): Promise<unknown> {
        const { provider } = scriptedModel(script, { maxRetries });
        const { emit } = recordingEmit();
        try {
            await runLoop(agentWith([]), [user("go")], makeSession(), options(provider, emit));
        } catch (err) {
            return err;
        }
        throw new Error("the run did not fail");
    }

    it("names a 503 on each retry a provider outage", async () => {
        const retryNow = { "retry-after-ms": "1" };
        const failure = await failureOfRun([{ fail: failing(503, retryNow) }, { fail: failing(503, retryNow) }, { fail: failing(503, retryNow) }], 2);
        expect(modelFailureOf(failure)).toEqual({ kind: "outage" });
    });

    it("names a status of the suspend map a billing refusal with its reason", async () => {
        expect(modelFailureOf(await failureOfRun([{ fail: failing(402) }]))).toEqual({ kind: "billing", reason: "payment_required" });
    });

    it("names a 401 a credential failure", async () => {
        expect(modelFailureOf(await failureOfRun([{ fail: failing(401) }]))).toEqual({ kind: "credential" });
    });

    it("names each other failure other", async () => {
        expect(modelFailureOf(await failureOfRun([{ fail: failing(422) }]))).toEqual({ kind: "other" });
        expect(modelFailureOf(new Error("a bug"))).toEqual({ kind: "other" });
    });
});
