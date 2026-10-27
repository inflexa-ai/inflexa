/**
 * A decision eval case, the history helpers that build its earlier turns, and
 * the graders that score one trial.
 *
 * A grader reads only the structured tool calls and the text of the reply.
 * No model judges a trial.
 */

import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";
import type { LoopStep } from "@inflexa-ai/harness/loop/run-loop.js";
import { modelViewOf } from "@inflexa-ai/harness/loop/tool-adapter.js";
import type { LoopMessage } from "@inflexa-ai/harness/loop/types.js";
import { syntheticRecordMessage } from "@inflexa-ai/harness/memory/ai-sdk-message-storage.js";
import type { ToolScript } from "./agent.js";

/** One call that the model made in a trial. */
export type TrialCall = {
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
    readonly refused: boolean;
};

/** One approval that a call asked the user for, before the call ran. */
export type TrialAsk = {
    readonly tool: string;
    readonly command: string;
};

/** What a grader reads of one trial. */
export type Trial = {
    readonly calls: readonly TrialCall[];
    readonly asks: readonly TrialAsk[];
    /** The text of each reply of the trial, joined. */
    readonly text: string;
    readonly finishReason: string;
};

export type Grade = { readonly pass: boolean; readonly detail: string };

export type Grader = (trial: Trial) => Grade;

/** The cases of a hill-climb loop are `dev`. The `held-out` cases stay out of it, and they show an overfit. */
export type CaseSet = "dev" | "held-out";

export type EvalCase = {
    readonly id: string;
    readonly set: CaseSet;
    /** The complaint, the issue, or the brief that the case comes from. */
    readonly source: string;
    /** The conversation before the turn, oldest first. */
    readonly history?: readonly LoopMessage[];
    /** The message of the user that opens the turn. */
    readonly user: string;
    /** The result of each tool that the trial can call. */
    readonly tools?: Readonly<Record<string, ToolScript>>;
    /** The model requests of a trial. A trial also ends when a reply calls no tool. */
    readonly maxSteps: number;
    /** The answer of the user to each approval that a call asks for. Absent: the user approves. */
    readonly approve?: "approve" | "deny";
    readonly grade: Grader;
};

export function userMessage(text: string): LoopMessage {
    return { role: "user", content: text };
}

export function assistantText(text: string): LoopMessage {
    return { role: "assistant", content: [{ type: "text", text }] };
}

/** A record that the harness appended to the thread, for example the approval of a plan. */
export function threadRecord(text: string): LoopMessage {
    return syntheticRecordMessage(text);
}

const JsonSchema = z.json();

let priorCallCount = 0;

/** An earlier call and its ok result, in the shape that the loop records them. */
export function priorCall(toolName: string, input: unknown, value: unknown, text?: string): LoopMessage[] {
    priorCallCount += 1;
    const toolCallId = `prior-${priorCallCount}`;
    const reply: LoopMessage = {
        role: "assistant",
        content: [...(text === undefined ? [] : [{ type: "text" as const, text }]), { type: "tool-call", toolCallId, toolName, input }],
    };
    const result: LoopMessage = {
        role: "tool",
        content: [{ type: "tool-result", toolCallId, toolName, output: modelViewOf({ outcome: "ok", value: JsonSchema.parse(value) }) }],
    };
    return [reply, result];
}

/** The calls of a trial, in the order that the model made them. */
export function trialOf(steps: readonly LoopStep[], asks: readonly TrialAsk[], text: string, finishReason: string): Trial {
    const calls = steps.flatMap((step, index) => step.calls.map((call) => ({ step: index, tool: call.toolName, input: call.input, refused: call.refused })));
    return { calls, asks, text, finishReason };
}

/** An input matches when each key of `expected` has the same value in the input. Other keys are free. */
export function inputMatches(input: unknown, expected: Readonly<Record<string, unknown>>): boolean {
    const record = parseUnknownRecord(input);
    if (record === undefined) return false;
    return Object.entries(expected).every(([key, value]) => isDeepStrictEqual(record[key], value));
}

function describeCalls(calls: readonly TrialCall[]): string {
    return calls.length === 0 ? "no tool call" : calls.map((call) => call.tool).join(", ");
}

/**
 * The first call to a tool of `among` is a call to `tool`, with an input that
 * matches `input`. A call to a tool outside `among` is free, for example a
 * lookup before the decision. A trial with no call of `among` fails.
 */
export function decides(tool: string, among: readonly string[], input: Readonly<Record<string, unknown>> = {}): Grader {
    const candidates = new Set([tool, ...among]);
    return (trial) => {
        const first = trial.calls.find((call) => candidates.has(call.tool));
        if (first === undefined) return { pass: false, detail: `no call of ${[...candidates].join(", ")} (calls: ${describeCalls(trial.calls)})` };
        if (first.tool !== tool) return { pass: false, detail: `decided ${first.tool}` };
        if (!inputMatches(first.input, input)) return { pass: false, detail: `${tool} with input ${JSON.stringify(first.input)}` };
        return { pass: true, detail: `decided ${tool}` };
    };
}

/** The first reply that calls a tool calls one of `tools`. A reply with text only fails. */
export function firstCallOneOf(tools: readonly string[]): Grader {
    return (trial) => {
        const first = trial.calls[0];
        if (first === undefined) return { pass: false, detail: "answered with no tool call" };
        const firstStep = trial.calls.filter((call) => call.step === first.step);
        const hit = firstStep.find((call) => tools.includes(call.tool));
        return hit === undefined ? { pass: false, detail: `first calls: ${describeCalls(firstStep)}` } : { pass: true, detail: `called ${hit.tool}` };
    };
}

/** No call to a tool of `tools`. */
export function never(tools: readonly string[]): Grader {
    return (trial) => {
        const hit = trial.calls.find((call) => tools.includes(call.tool));
        return hit === undefined ? { pass: true, detail: `no call of ${tools.join(", ")}` } : { pass: false, detail: `called ${hit.tool}` };
    };
}

/** At most `limit` calls to `tool`. */
export function atMost(tool: string, limit: number): Grader {
    return (trial) => {
        const count = trial.calls.filter((call) => call.tool === tool).length;
        return { pass: count <= limit, detail: `${count} calls of ${tool}` };
    };
}

/** No call to `tool` with an input that matches `input`. */
export function neverWith(tool: string, input: Readonly<Record<string, unknown>>): Grader {
    return (trial) => {
        const hit = trial.calls.find((call) => call.tool === tool && inputMatches(call.input, input));
        return hit === undefined
            ? { pass: true, detail: `no ${tool} call with ${JSON.stringify(input)}` }
            : { pass: false, detail: `called ${tool} with ${JSON.stringify(hit.input)}` };
    };
}

/**
 * A call of `tool` asked the user for approval, and the command of the ask holds each of `words`. The
 * call reached the user as an approval ask, not as a question in the text of the reply.
 */
export function asked(tool: string, words: readonly string[] = []): Grader {
    return (trial) => {
        const hit = trial.asks.find((ask) => ask.tool === tool && words.every((word) => ask.command.includes(word)));
        if (hit !== undefined) return { pass: true, detail: `asked: ${hit.command}` };
        const asks = trial.asks.length === 0 ? "no ask" : trial.asks.map((ask) => ask.command).join("; ");
        return { pass: false, detail: `no ${tool} ask with ${words.join(" ")} (${asks}; calls: ${describeCalls(trial.calls)})` };
    };
}

/** No approval ask of `tool` whose command holds each of `words`. */
export function notAsked(tool: string, words: readonly string[] = []): Grader {
    return (trial) => {
        const hit = trial.asks.find((ask) => ask.tool === tool && words.every((word) => ask.command.includes(word)));
        return hit === undefined ? { pass: true, detail: `no ${tool} ask with ${words.join(" ")}` } : { pass: false, detail: `asked: ${hit.command}` };
    };
}

/** Each grader passes. The detail names the first failure. */
export function all(...graders: readonly Grader[]): Grader {
    return (trial) => {
        const grades = graders.map((grader) => grader(trial));
        const failed = grades.find((grade) => !grade.pass);
        return failed ?? { pass: true, detail: grades.map((grade) => grade.detail).join("; ") };
    };
}
