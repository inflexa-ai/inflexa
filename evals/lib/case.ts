/**
 * A decision eval case, the history helpers that build its earlier turns, and
 * the graders that score one trial.
 *
 * A grader reads only the structured tool calls and the text of the reply.
 * No model judges a trial.
 */

import type { StepSummary } from "@inflexa-ai/harness/schemas/step-summary.js";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { parseUnknownRecord } from "@inflexa-ai/harness/lib/unknown-containers.js";
import type { LoopStep } from "@inflexa-ai/harness/loop/run-loop.js";
import { modelViewOf } from "@inflexa-ai/harness/loop/tool-adapter.js";
import type { LoopMessage } from "@inflexa-ai/harness/loop/types.js";
import { syntheticRecordMessage } from "@inflexa-ai/harness/memory/ai-sdk-message-storage.js";
import type { AgentKind, ToolScript } from "./agent.js";
import type { SandboxSetup } from "./sandbox.js";

/** One call that the model made in a trial. */
export type TrialCall = {
    readonly step: number;
    readonly tool: string;
    readonly input: unknown;
    readonly refused: boolean;
    /** The call ran, and its result is ok. Absent for a nested call of a script. */
    readonly ok?: boolean;
    /** The ok value of a terminal `submit_` call, which a grader reads. Absent for each other call. */
    readonly value?: unknown;
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
    /** The trial reached its `maxSteps` with a request that still called a tool. */
    readonly capped: boolean;
    /** A sandbox trial: the text of each file under the working directory at the end, by relative path. */
    readonly files?: Readonly<Record<string, string>>;
    /** A sandbox trial: each command that no exec rule answered. */
    readonly unscripted?: readonly string[];
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
    /** The tree, the farm, and the exec rules of a sandbox case. */
    readonly sandbox?: SandboxSetup;
    /** The narrative of the plan and the step summaries of a synthesis case. They make the seed of the synthesizer. */
    readonly synthesis?: { readonly narrative: string; readonly summaries: readonly StepSummary[] };
    /** The bound of one trial, in milliseconds. Absent: the bound of the run. */
    readonly timeoutMs?: number;
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

/** The calls of each script of a trial, by the id of its `run_script` call, from the frames that the script emitted. */
export type ScriptCallInputs = ReadonlyMap<string, ReadonlyArray<{ readonly tool: string; readonly input: unknown }>>;

/**
 * The calls of a trial, in the order that the model made them. A call of `run_script` is followed by the tool calls of
 * its script, with the input that the script gave each one, thus a grader reads a call the same in a script and in a
 * direct call.
 */
export function trialOf(
    steps: readonly LoopStep[],
    asks: readonly TrialAsk[],
    text: string,
    finishReason: string,
    extra: Pick<Trial, "files" | "unscripted"> & { readonly maxSteps?: number; readonly scriptCalls?: ScriptCallInputs } = {},
): Trial {
    const calls = steps.flatMap((step, index) =>
        step.calls.flatMap((call) => {
            const ok = call.output?.outcome === "ok";
            const own: TrialCall = {
                step: index,
                tool: call.toolName,
                input: call.input,
                refused: call.refused,
                ok,
                value: ok && call.toolName.startsWith("submit_") && call.output?.outcome === "ok" ? call.output.value : undefined,
            };
            const script = call.toolName === "run_script" && call.output?.outcome === "ok" ? ScriptCallsSchema.safeParse(call.output.value) : undefined;
            const started = call.toolName === "run_script" ? extra.scriptCalls?.get(call.toolCallId) : undefined;
            const nested =
                started !== undefined
                    ? started.map((inner) => ({ step: index, tool: inner.tool, input: inner.input, refused: false }))
                    : script?.success === true
                      ? script.data.calls.map((inner) => ({ step: index, tool: inner.tool, input: undefined, refused: false }))
                      : [];
            return [own, ...nested];
        }),
    );
    const stepFinishes = steps.map((step) =>
        step.rawFinishReason === undefined || step.rawFinishReason === step.finishReason ? step.finishReason : `${step.finishReason} (${step.rawFinishReason})`,
    );
    const capped = extra.maxSteps !== undefined && steps.length >= extra.maxSteps && (steps.at(-1)?.calls.length ?? 0) > 0;
    return { calls, asks, text, finishReason, stepFinishes, capped, files: extra.files, unscripted: extra.unscripted };
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

/** A call of `tool` whose input holds each of `words`, in any case. */
export function submits(tool: string, words: readonly string[]): Grader {
    return (trial) => {
        const calls = trial.calls.filter((call) => call.tool === tool);
        if (calls.length === 0) return { pass: false, detail: `no call of ${tool} (calls: ${describeCalls(trial.calls)})` };
        const hit = calls.find((call) => {
            const text = JSON.stringify(call.input).toLowerCase();
            return words.every((word) => text.includes(word.toLowerCase()));
        });
        return hit === undefined
            ? { pass: false, detail: `${tool} names none of ${words.join(", ")}` }
            : { pass: true, detail: `${tool} names ${words.join(", ")}` };
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

/** Each grader passes. The detail is the detail of the first failure, or of each pass. */
export function all(...graders: readonly Grader[]): Grader {
    return (trial) => {
        const grades = graders.map((grader) => grader(trial));
        const failed = grades.find((grade) => !grade.pass);
        return failed ?? { pass: true, detail: grades.map((grade) => grade.detail).join("; ") };
    };
}

/** One grader passes. */
export function anyOf(...graders: readonly Grader[]): Grader {
    return (trial) => {
        const grades = graders.map((grader) => grader(trial));
        return grades.find((grade) => grade.pass) ?? { pass: false, detail: grades.map((grade) => grade.detail).join(" / ") };
    };
}

/** The text of the replies does not hold `text`. */
export function notMentions(text: string): Grader {
    return (trial) => (trial.text.includes(text) ? { pass: false, detail: `the reply mentions ${text}` } : { pass: true, detail: `no mention of ${text}` });
}

const CommandInputSchema = z.object({ command: z.array(z.string()) });

/** The command line of an `execute_command` call, or `undefined` for another call. */
function commandOf(call: TrialCall): string | undefined {
    if (call.tool !== "execute_command") return undefined;
    const parsed = CommandInputSchema.safeParse(call.input);
    return parsed.success ? parsed.data.command.join(" ") : undefined;
}

/** Some `execute_command` call runs a command line that matches `pattern`. */
export function execs(pattern: RegExp): Grader {
    return (trial) => {
        const lines = trial.calls.map(commandOf).filter((line) => line !== undefined);
        const hit = lines.find((line) => pattern.test(line));
        return hit === undefined
            ? { pass: false, detail: `no command matches ${String(pattern)} (${lines.join(" | ") || "no command"})` }
            : { pass: true, detail: `ran ${hit}` };
    };
}

/** No `execute_command` call runs a command line that matches `pattern`. */
export function neverExec(pattern: RegExp): Grader {
    return (trial) => {
        const hit = trial.calls.map(commandOf).find((line) => line !== undefined && pattern.test(line));
        return hit === undefined ? { pass: true, detail: `no command matches ${String(pattern)}` } : { pass: false, detail: `ran ${hit}` };
    };
}

/** A call that a grader looks for: a tool, and a test of its input. */
export type CallMatch = { readonly tool: string; readonly input?: (input: unknown) => boolean };

function matches(call: TrialCall, match: CallMatch): boolean {
    return call.tool === match.tool && (match.input === undefined || match.input(call.input));
}

/** The first call that matches `first` comes before the first call that matches `then`, and both happen. */
export function before(first: CallMatch, then: CallMatch): Grader {
    return (trial) => {
        const a = trial.calls.findIndex((call) => matches(call, first));
        const b = trial.calls.findIndex((call) => matches(call, then));
        if (a === -1) return { pass: false, detail: `no ${first.tool} (calls: ${describeCalls(trial.calls)})` };
        if (b === -1) return { pass: false, detail: `no ${then.tool} (calls: ${describeCalls(trial.calls)})` };
        return a < b ? { pass: true, detail: `${first.tool} before ${then.tool}` } : { pass: false, detail: `${then.tool} before ${first.tool}` };
    };
}

/** At most `limit` calls match `match`. */
export function atMost(match: CallMatch, limit: number): Grader {
    return (trial) => {
        const count = trial.calls.filter((call) => matches(call, match)).length;
        return { pass: count <= limit, detail: `${count} calls of ${match.tool}` };
    };
}

const BlockerInputSchema = z.object({ reason: z.string() });

function blockerReason(trial: Trial): string | undefined {
    const call = trial.calls.find((c) => c.tool === "report_blocker" && c.ok !== false);
    const parsed = BlockerInputSchema.safeParse(call?.input);
    return parsed.success ? parsed.data.reason : undefined;
}

/** The reason of the first `report_blocker` call holds each of `words`, with no regard to case. */
export function blockerSays(words: readonly string[]): Grader {
    return (trial) => {
        const reason = blockerReason(trial);
        if (reason === undefined) return { pass: false, detail: `no report_blocker (calls: ${describeCalls(trial.calls)})` };
        const missing = words.filter((word) => !reason.toLowerCase().includes(word.toLowerCase()));
        return missing.length === 0
            ? { pass: true, detail: `blocker: ${reason}` }
            : { pass: false, detail: `the blocker does not name ${missing.join(", ")}: ${reason}` };
    };
}

/** No `report_blocker` call has a reason that matches `pattern`. */
export function blockerNot(pattern: RegExp): Grader {
    return (trial) => {
        const reason = blockerReason(trial);
        return reason !== undefined && pattern.test(reason) ? { pass: false, detail: `blocker: ${reason}` } : { pass: true, detail: "no such blocker" };
    };
}

const PathInputSchema = z.object({ path: z.string().optional(), pattern: z.string().optional() });

/** No call of `tools` names a path under `prefix`, and no command lists or searches it with `ls`, `find`, or `tree`. */
export function noCallUnder(tools: readonly string[], prefix: string): Grader {
    return (trial) => {
        const hit = trial.calls.find((call) => {
            if (tools.includes(call.tool)) {
                const parsed = PathInputSchema.safeParse(call.input);
                return parsed.success && (parsed.data.path ?? "").startsWith(prefix);
            }
            const line = commandOf(call);
            return (
                line !== undefined && ["ls ", "find ", "tree "].some((word) => line.startsWith(word) || line.includes(`&& ${word}`)) && line.includes(prefix)
            );
        });
        return hit === undefined ? { pass: true, detail: `no search under ${prefix}` } : { pass: false, detail: `${hit.tool} ${JSON.stringify(hit.input)}` };
    };
}

/** The working directory holds `path` at the end of the trial. */
export function hasFile(path: string): Grader {
    return (trial) =>
        trial.files?.[path] !== undefined
            ? { pass: true, detail: `wrote ${path}` }
            : { pass: false, detail: `no ${path} (files: ${Object.keys(trial.files ?? {}).join(", ") || "none"})` };
}

/** The working directory holds a file under `dir` whose text matches `pattern`, or any file under it with no pattern. */
export function wroteUnder(dir: string, pattern?: RegExp): Grader {
    return (trial) => {
        const hit = Object.entries(trial.files ?? {}).find(([path, text]) => path.startsWith(dir) && (pattern === undefined || pattern.test(text)));
        return hit === undefined
            ? {
                  pass: false,
                  detail: `no file under ${dir}${pattern === undefined ? "" : ` that matches ${String(pattern)}`} (files: ${Object.keys(trial.files ?? {}).join(", ") || "none"})`,
              }
            : { pass: true, detail: `wrote ${hit[0]}` };
    };
}

/** No file of the working directory has a text that matches `pattern`. */
export function noFileMatches(pattern: RegExp): Grader {
    return (trial) => {
        const hit = Object.entries(trial.files ?? {}).find(([, text]) => pattern.test(text));
        return hit === undefined
            ? { pass: true, detail: `no file matches ${String(pattern)}` }
            : { pass: false, detail: `${hit[0]} matches ${String(pattern)}` };
    };
}

/** The trial did not stop at its `maxSteps` with a call still open, thus the agent decided within its budget. */
export const settled: Grader = (trial) => (trial.capped ? { pass: false, detail: "the trial reached maxSteps" } : { pass: true, detail: "settled" });

const AcceptedSchema = z.object({ status: z.literal("accepted") });

/** The last `submit_profile` call that the tool accepted has an input that meets `check`. */
export function acceptedProfile(describe: string, check: (input: unknown) => boolean): Grader {
    return (trial) => {
        const accepted = trial.calls.filter((call) => call.tool === "submit_profile" && AcceptedSchema.safeParse(call.value).success);
        const last = accepted.at(-1);
        if (last === undefined) {
            const submits = trial.calls.filter((call) => call.tool === "submit_profile").length;
            return { pass: false, detail: `no accepted submit_profile (${submits} submits; calls: ${describeCalls(trial.calls)})` };
        }
        return check(last.input) ? { pass: true, detail: describe } : { pass: false, detail: `not ${describe}: ${JSON.stringify(last.input).slice(0, 300)}` };
    };
}

/** At most `limit` distinct paths that match `pattern` appear in the read calls and in the commands of a trial. */
export function distinctPaths(pattern: RegExp, limit: number): Grader {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return (trial) => {
        const seen = new Set<string>();
        for (const call of trial.calls) {
            if (call.tool === "submit_profile") continue;
            for (const hit of JSON.stringify(call.input ?? "").matchAll(global)) seen.add(hit[0]);
        }
        return seen.size <= limit
            ? { pass: true, detail: `${seen.size} distinct paths` }
            : { pass: false, detail: `${seen.size} distinct paths: ${[...seen].slice(0, 6).join(", ")}` };
    };
}
