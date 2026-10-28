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
import type { AgentKind, ToolScript } from "./agent.js";

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
    /** The finish of each model request, in order, with the raw reason of the provider when it differs. */
    readonly stepFinishes: readonly string[];
};

export type Grade = { readonly pass: boolean; readonly detail: string };

export type Grader = (trial: Trial) => Grade;

/** The cases of a hill-climb loop are `dev`. The `held-out` cases stay out of it, and they show an overfit. */
export type CaseSet = "dev" | "held-out";

/** A run that is running when the turn opens. */
export type RunningRun = { readonly runId: string; readonly planId?: string; readonly startedAt: string };

/** The state that a chat turn reads into the context records after the user message. Absent fields are empty. */
export type TurnState = {
    readonly analysisContext?: string;
    readonly runningRuns?: readonly RunningRun[];
    readonly workingMemory?: string;
};

export type EvalCase = {
    readonly id: string;
    readonly set: CaseSet;
    /** The agent of the turn. Absent: the conversation agent. The message of a planner case is the seed of the planner. */
    readonly agent?: AgentKind;
    /** The complaint, the issue, or the brief that the case comes from. */
    readonly source: string;
    /** The conversation before the turn, oldest first. */
    readonly history?: readonly LoopMessage[];
    /** The message of the user that opens the turn. */
    readonly user: string;
    readonly state?: TurnState;
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

const ScriptCallsSchema = z.object({ calls: z.array(z.object({ tool: z.string() })) });

/**
 * The calls of a trial, in the order that the model made them. A call of `run_script` is followed by the tool calls of
 * its script, with no input, thus a grader counts a lookup the same in a script and in a direct call.
 */
export function trialOf(steps: readonly LoopStep[], asks: readonly TrialAsk[], text: string, finishReason: string): Trial {
    const calls = steps.flatMap((step, index) =>
        step.calls.flatMap((call) => {
            const own: TrialCall = { step: index, tool: call.toolName, input: call.input, refused: call.refused };
            const script = call.toolName === "run_script" && call.output?.outcome === "ok" ? ScriptCallsSchema.safeParse(call.output.value) : undefined;
            const nested =
                script?.success === true ? script.data.calls.map((inner) => ({ step: index, tool: inner.tool, input: undefined, refused: false })) : [];
            return [own, ...nested];
        }),
    );
    const stepFinishes = steps.map((step) =>
        step.rawFinishReason === undefined || step.rawFinishReason === step.finishReason ? step.finishReason : `${step.finishReason} (${step.rawFinishReason})`,
    );
    return { calls, asks, text, finishReason, stepFinishes };
}

/** An input matches when each key of `expected` has the same value in the input. Other keys are free. */
export function inputMatches(input: unknown, expected: Readonly<Record<string, unknown>>): boolean {
    // A nested call of a script carries no input, and an empty expectation asks for none.
    if (Object.keys(expected).length === 0) return true;
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

/** A call to a tool of `tools` at any step. A lookup before it is free, and an answer with no such call fails. */
export function callsAny(tools: readonly string[]): Grader {
    return (trial) => {
        const hit = trial.calls.find((call) => tools.includes(call.tool));
        return hit === undefined
            ? { pass: false, detail: `no call of ${tools.join(", ")} (calls: ${describeCalls(trial.calls)})` }
            : { pass: true, detail: `called ${hit.tool}` };
    };
}

/** No call to a tool of `tools`. */
export function never(tools: readonly string[]): Grader {
    return (trial) => {
        const hit = trial.calls.find((call) => tools.includes(call.tool));
        return hit === undefined ? { pass: true, detail: `no call of ${tools.join(", ")}` } : { pass: false, detail: `called ${hit.tool}` };
    };
}

/** At most `limit` calls to `tool` whose input sets `key`. A call without the key is free. */
export function atMostWith(tool: string, key: string, limit: number): Grader {
    return (trial) => {
        const count = trial.calls.filter((call) => call.tool === tool && parseUnknownRecord(call.input)?.[key] !== undefined).length;
        return { pass: count <= limit, detail: `${count} calls of ${tool} with ${key}` };
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

/** The text of the replies holds `text`, for example the count that a question asks for. */
export function mentions(text: string): Grader {
    return (trial) => (trial.text.includes(text) ? { pass: true, detail: `mentions ${text}` } : { pass: false, detail: `the reply does not mention ${text}` });
}

/** One step of a plan, as `submit_plan` takes it. A grader reads the fields that it names. */
export type PlanStepView = {
    readonly id: string;
    readonly agent: string;
    readonly name: string;
    readonly question: string;
    readonly depends_on: readonly string[];
};

const PlanViewSchema = z.object({
    plan: z.object({
        steps: z.array(
            z.object({
                id: z.string(),
                agent: z.string().catch(""),
                name: z.string().catch(""),
                question: z.string().catch(""),
                depends_on: z.array(z.string()).catch([]),
            }),
        ),
    }),
});

/**
 * The plan of the last `submit_plan` call meets `check`. The real check of `submit_plan` runs in a planner case, thus
 * a rejected plan that the planner repairs is graded by its repair.
 */
export function plans(describe: string, check: (steps: readonly PlanStepView[]) => boolean): Grader {
    return (trial) => {
        const last = trial.calls.filter((call) => call.tool === "submit_plan").at(-1);
        if (last === undefined) return { pass: false, detail: `no submit_plan (calls: ${describeCalls(trial.calls)})` };
        const parsed = PlanViewSchema.safeParse(last.input);
        if (!parsed.success) return { pass: false, detail: "the last submit_plan holds no plan with steps" };
        const steps = parsed.data.plan.steps;
        const shape = steps.map((step) => `${step.id}:${step.agent}`).join(", ");
        return check(steps) ? { pass: true, detail: `${describe} (${shape})` } : { pass: false, detail: `not ${describe} (${shape})` };
    };
}

/** The text of the replies holds `text`, for example the count that a question asks for. */
export function all(...graders: readonly Grader[]): Grader {
    return (trial) => {
        const grades = graders.map((grader) => grader(trial));
        const failed = grades.find((grade) => !grade.pass);
        return failed ?? { pass: true, detail: grades.map((grade) => grade.detail).join("; ") };
    };
}
