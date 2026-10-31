/**
 * The adapter from a harness `Tool` to an AI SDK tool.
 *
 * Each call runs as one durable step inside a workflow (`durableTools`), and
 * directly outside one. The step output is one plain JSON value, the
 * `ToolCallOutput`: the outcome of the call, its value or its excerpt, the
 * call record, and the pictures. Thus a replay gets back each fact that the
 * loop reads later, and the tool body does not run again.
 *
 * The adapter never throws for a failed call: the failure becomes an error
 * output that the model reads. Only a fatal error leaves the call, for example
 * the cancel of the workflow, and the loop then ends the run with it.
 *
 * The model reads the view that `toModelOutput` builds from the output. It never
 * reads the call record.
 */

import { durableTools } from "@dbos-inc/vercel-ai";
import { jsonSchema, tool as aiTool, type ToolSet, type UIMessageStreamWriter } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { z } from "zod";

import type { ToolCallValue } from "../contracts/chat-events.js";
import type { AgentSession } from "../auth/types.js";
import { stripNulCharacters } from "../input-sanitization.js";
import type { Logger } from "../lib/logger.js";
import { ResultError } from "../lib/result.js";
import { errorMessageOf, errorNameOf, errorOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { describeZodIssueShapes } from "../lib/zod-issue-shape.js";
import { hintForZodIssue, repairToolInput } from "../lib/zod-issues.js";
import { classifyProviderError } from "../providers/errors.js";
import type { ProviderCapabilities } from "../providers/types.js";
import { isWorkflowCancellation } from "../runtime/dbos.js";
import {
    isToolError,
    readToolCallRecord,
    readToolResultImages,
    type Tool,
    type ToolContext,
    type ToolError,
    type ToolResultImage,
} from "../tools/define-tool.js";
import { recordKeyFor } from "./accounting.js";
import type { AgentRunUsage } from "./metrics.js";
import { computeDetail, computeResultDetail, type ToolCallDetail } from "./tool-detail.js";
import type { ToolOutcome } from "./tool-outcome.js";
import { excerptOf, keptTextOf, TOOL_RESULT_CAP, toolOutputRef, type ToolOutputStore } from "./tool-output.js";
import { errorToolValue, makeToolCallValue } from "./tool-value.js";
import type { EmitFn, EventSource } from "./types.js";

const ToolResultImageSchema = z.object({ base64: z.string(), mediaType: z.string() });

const JsonSchema = z.json();

type Json = z.infer<typeof JsonSchema>;

/**
 * The output of one tool call, as its step records it.
 *
 * - `ok`: the value that the tool gave, or the excerpt of a value longer than
 *   the cap. A cut value keeps only its excerpt. `record` is the call record,
 *   and `images` are the pictures that the wire of the run carries.
 * - `error`: the text that the model reads, already cut when it is long.
 * - `denied`: the user rejected the approval that the tool asked for.
 */
export const ToolCallOutputSchema = z.discriminatedUnion("outcome", [
    z.object({
        outcome: z.literal("ok"),
        value: JsonSchema.optional(),
        excerpt: z.string().optional(),
        record: JsonSchema.optional(),
        images: z.array(ToolResultImageSchema).optional(),
    }),
    z.object({ outcome: z.literal("error"), text: z.string() }),
    z.object({ outcome: z.literal("denied"), reason: z.string() }),
]);

export type ToolCallOutput = z.infer<typeof ToolCallOutputSchema>;

/** The facts of a run that each tool call of the run reads. */
export type ToolRunContext = {
    readonly session: AgentSession;
    readonly source: EventSource;
    readonly emit: EmitFn;
    readonly turnUsage: AgentRunUsage;
    readonly capabilities: ProviderCapabilities;
    /** Keeps the text of each cut result. Absent: the run cuts, and it keeps nothing. */
    readonly store?: ToolOutputStore;
    readonly invocationId?: string;
    readonly log: Logger;
    /** Ends the run with a fatal error of a tool call. */
    readonly fail: (err: unknown) => void;
    /**
     * Receives the chunks that a tool step writes through `toolWriter()` of the library. A chunk that is not
     * transient is checkpointed with the step, and a replay of the step gives it again.
     */
    readonly writer?: UIMessageStreamWriter;
};

/**
 * The input of a recorded call as the call itself read it. A stringified
 * argument gets the repair of the call, thus a selector of the outcome reads
 * the value that the tool checked.
 */
export function recordedInputOf<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const repaired = schema.safeParse(repairToolInput(raw, parsed.error));
    return repaired.success ? repaired.data : undefined;
}

/** A cancel of the run or of its workflow is control flow, never a result that the model reads. */
export function isFatalToolError(err: unknown): boolean {
    return errorNameOf(err) === "AbortError" || isWorkflowCancellation(err);
}

/**
 * The AI SDK tools of a run. Inside a workflow each call is a durable step
 * named `<tool>.<toolCallId>`. A throw from a call is fatal by construction,
 * because the adapter turns each other failure into an output.
 */
export function adaptTools(tools: readonly Tool[], run: ToolRunContext): ToolSet {
    const set: ToolSet = {};
    for (const harnessTool of tools) {
        set[harnessTool.id] = aiTool({
            description: harnessTool.description,
            // No validation here: the call validates its input, thus a failure keeps
            // the repair of a stringified argument and the hints of the harness.
            inputSchema: jsonSchema(harnessTool.jsonSchema),
            execute: (input: unknown, options: { readonly toolCallId: string; readonly abortSignal?: AbortSignal }): Promise<ToolCallOutput> =>
                runToolCall(harnessTool, input, options, run),
            toModelOutput: ({ output }: { readonly output: ToolCallOutput }): ToolResultOutput => modelViewOf(output),
        });
    }
    // A call that starts a child workflow runs in the body, because a step cannot start a workflow.
    const inBody = Object.fromEntries(tools.filter((tool) => tool.startsWorkflow === true).map((tool) => [tool.id, false as const]));
    const durable = durableTools(set, { tools: inBody, writer: run.writer });
    const guarded: ToolSet = {};
    for (const [name, definition] of Object.entries(durable)) {
        const execute = definition.execute;
        if (execute === undefined) {
            guarded[name] = definition;
            continue;
        }
        guarded[name] = {
            ...definition,
            execute: async (input: unknown, options: Parameters<typeof execute>[1]): Promise<unknown> => {
                try {
                    return await execute(input, options);
                } catch (err) {
                    run.fail(err);
                    throw err;
                }
            },
        };
    }
    return guarded;
}

/** What the model reads of one output. */
export function modelViewOf(output: ToolCallOutput): ToolResultOutput {
    switch (output.outcome) {
        case "ok": {
            const images = output.images ?? [];
            if (images.length > 0) {
                return {
                    type: "content",
                    value: [
                        { type: "text", text: output.excerpt ?? JSON.stringify(output.value ?? null) },
                        ...images.map((image) => ({ type: "file" as const, mediaType: image.mediaType, data: { type: "data" as const, data: image.base64 } })),
                    ],
                };
            }
            return output.excerpt === undefined ? { type: "json", value: output.value ?? null } : { type: "text", value: output.excerpt };
        }
        case "error":
            return { type: "error-text", value: output.text };
        case "denied":
            return { type: "execution-denied", reason: output.reason };
    }
}

/** The outcome that an event and a counter report for one output. */
export function outcomeOf(output: ToolCallOutput): ToolOutcome {
    return output.outcome;
}

/** Hand the call record of each output to its tool, in the order of the calls. A throw is logged, because the call has settled already. */
export function foldCallRecords(
    tools: readonly Tool[],
    calls: readonly { readonly toolName: string; readonly toolCallId: string; readonly output?: ToolCallOutput }[],
    log: Logger,
): void {
    const byId = new Map(tools.map((t) => [t.id, t]));
    for (const call of calls) {
        const output = call.output;
        if (output?.outcome !== "ok" || output.record === undefined) continue;
        const tool = byId.get(call.toolName);
        if (tool?.foldCallRecord === undefined) continue;
        try {
            tool.foldCallRecord(output.record);
        } catch (err) {
            log.error("a tool call record did not fold", { tool: tool.id, toolCallId: call.toolCallId, ...log.errorFields(err) });
        }
    }
}

async function runToolCall(
    tool: Tool,
    input: unknown,
    options: { readonly toolCallId: string; readonly abortSignal?: AbortSignal },
    run: ToolRunContext,
): Promise<ToolCallOutput> {
    const startedAt = performance.now();
    const { toolCallId } = options;
    const detail = computeDetail(tool, input, run.log);
    // Only a root call shows values: no reader shows the values of a sub-agent call or of a nested call of a script.
    const showsValues = run.source.callPath.length <= 1;
    // The emit and the call start before the first await: a call that runs in the body of a workflow takes its
    // function ids in the order of the calls, thus a replay gives each call its own child.
    const shownInput = showsValues ? viewInputValue(tool, input, run.log) : undefined;
    const started = run.emit({
        type: "tool-started",
        source: run.source,
        toolUseId: toolCallId,
        name: tool.id,
        ...detailField(detail),
        input: shownInput,
    });
    const ctx: ToolContext = {
        invocationId: toolCallId,
        session: run.session,
        signal: options.abortSignal ?? new AbortController().signal,
        emit: run.emit,
        turnUsage: run.turnUsage,
    };
    // One wait reads the two, thus a failed emit leaves no rejection of the call unread.
    const [, settled] = await Promise.all([started, settleCall(tool, input, ctx, run, showsValues)]);
    // The values come from the output before the cut for the model, thus a host shows the start and the end of the whole text.
    const shownError = showsValues && settled.output.outcome === "error" ? viewErrorValue(tool, settled.output.text) : undefined;
    const output = await cutLongOutput(settled.output, tool.id, toolCallId, run);
    await run.emit({
        type: "tool-finished",
        source: run.source,
        toolUseId: toolCallId,
        name: tool.id,
        outcome: output.outcome,
        ...detailField(settled.detail ?? detail),
        durationMs: Math.round(performance.now() - startedAt),
        input: shownInput,
        result: settled.result,
        error: shownError,
    });
    return output;
}

type SettledCall = {
    readonly output: ToolCallOutput;
    /** The line that the result hook of the tool made of its ok value. */
    readonly detail?: ToolCallDetail;
    /** The value that the result member of the view made of the ok value. */
    readonly result?: ToolCallValue;
};

async function settleCall(tool: Tool, input: unknown, ctx: ToolContext, run: ToolRunContext, showsValues: boolean): Promise<SettledCall> {
    const parsed = tool.inputSchema.safeParse(input);
    let data: unknown;
    if (parsed.success) {
        data = parsed.data;
    } else {
        // A complete JSON argument can arrive as a string behind function-call
        // markup or a code fence. Repair only makes the schema reachable — the
        // repaired value is validated in full, and the tool's own semantic checks
        // still run, so nothing here weakens validation.
        const repairedInput = repairToolInput(input, parsed.error);
        const repaired = repairedInput === undefined ? undefined : tool.inputSchema.safeParse(repairedInput);
        if (repaired?.success !== true) {
            // The Zod text can quote the input, thus the log gets only the shape of the failure.
            run.log.warn("tool call rejected", { tool: tool.id, toolCallId: ctx.invocationId, issues: describeZodIssueShapes(parsed.error, tool.inputSchema) });
            return { output: errorOutput(`input validation failed: ${formatZodIssues(parsed.error, input)}`) };
        }
        data = repaired.data;
    }

    try {
        const result = await tool.execute(data, ctx);
        if (result.isErr()) {
            logToolFailure(tool, ctx.invocationId, result.error, run.log);
            return { output: errorOutput(toolErrorContent(result.error)) };
        }
        // The one place a result description runs: the ok value in hand, the
        // input already validated, and the guard inside the compute.
        return {
            output: okOutput(tool.id, result.value, run),
            detail: computeResultDetail(tool, data, result.value, run.log),
            result: showsValues ? viewResultValue(tool, data, result.value, run.log) : undefined,
        };
    } catch (err) {
        if (isFatalToolError(err)) throw err;
        logToolFailure(tool, ctx.invocationId, err, run.log);
        return { output: errorOutput(toolErrorContent(err)) };
    }
}

/**
 * The value of the output of a view member, or `undefined`. A value that breaks a rule or does not serialize gives no
 * value and logs one warning with the reason, as a member that throws does. A member that gives `undefined` gives no
 * value and no warning.
 */
function shownValue(tool: Tool, member: "input" | "result", output: unknown, log: Logger): ToolCallValue | undefined {
    const made = makeToolCallValue(output);
    if (made.isErr()) {
        log.warn(`the ${member} view of a tool gave a value that cannot show`, { tool: tool.id, reason: made.error });
        return undefined;
    }
    return made.value;
}

/**
 * The shown input of a call: the `input` member of the view of the tool, run on the input after the parse with the input
 * schema. The parse is inside the guard, because a schema with an async refinement throws on a synchronous parse. A
 * tool with no `input` member, an input that fails the parse, a member that throws, and a value that breaks a rule give
 * no value, and each of the last two logs one warning. A value never fails a call.
 */
export function viewInputValue(tool: Tool, rawInput: unknown, log: Logger): ToolCallValue | undefined {
    const view = tool.view;
    if (typeof view?.input !== "function") return undefined;
    try {
        const parsed = recordedInputOf(tool.inputSchema, rawInput);
        if (parsed === undefined) return undefined;
        return shownValue(tool, "input", view.input(parsed), log);
    } catch (err) {
        log.warn("the input view of a tool failed", { tool: tool.id, ...log.errorFields(err) });
        return undefined;
    }
}

/** The shown result of a call that ended `ok`: the `result` member of the view, run on the parsed input and the ok value. The guard is that of {@link viewInputValue}. */
function viewResultValue(tool: Tool, parsedInput: unknown, result: unknown, log: Logger): ToolCallValue | undefined {
    const view = tool.view;
    if (typeof view?.result !== "function") return undefined;
    try {
        return shownValue(tool, "result", view.result(parsedInput, result), log);
    } catch (err) {
        log.warn("the result view of a tool failed", { tool: tool.id, ...log.errorFields(err) });
        return undefined;
    }
}

/** The shown error of a call that ended `error`, when the view declares `error`. `text` is the error text that the model reads, before the cut. */
function viewErrorValue(tool: Tool, text: string): ToolCallValue | undefined {
    return tool.view?.error === true ? errorToolValue(text) : undefined;
}

/**
 * The ok output of a value. The JSON data loses each NUL, and the pictures leave
 * it. A wire that carries no picture in a tool result gets the text alone, and
 * one warn with the count rides the log: base64 text floods the context, and the
 * model cannot see it.
 */
function okOutput(toolId: string, value: unknown, run: ToolRunContext): ToolCallOutput {
    const output: { -readonly [K in keyof Extract<ToolCallOutput, { outcome: "ok" }>]: Extract<ToolCallOutput, { outcome: "ok" }>[K] } = {
        outcome: "ok",
        value: jsonValue(value),
    };
    const record = readToolCallRecord(value);
    // The record crosses the step cache, thus the contract of a call record is plain JSON.
    if (record !== undefined) output.record = jsonValue(record);
    const images = readToolResultImages(value);
    if (images.length > 0) {
        if (run.capabilities.imageToolResults === true) {
            output.images = images.map((image: ToolResultImage) => ({ base64: image.base64, mediaType: image.mediaType }));
        } else {
            run.log.warn("the wired provider carries no picture in a tool result, thus the pictures are dropped", {
                toolName: toolId,
                imageCount: images.length,
            });
        }
    }
    return output;
}

function errorOutput(text: string): ToolCallOutput {
    // A thrown tool error routinely quotes stderr verbatim — as exposed to NUL as a success payload.
    return { outcome: "error", text: stripNulCharacters(text) };
}

/**
 * The output with an excerpt in place of a text longer than the cap. The text
 * is kept first under a reference that a rerun of the call gives again, and the
 * excerpt does not depend on the outcome of the put. Thus a rerun gives the
 * same bytes.
 */
async function cutLongOutput(output: ToolCallOutput, toolName: string, toolCallId: string, run: ToolRunContext): Promise<ToolCallOutput> {
    if (output.outcome === "denied") return output;
    const text = output.outcome === "ok" ? JSON.stringify(output.value ?? null) : output.text;
    if (text.length <= TOOL_RESULT_CAP) return output;

    let kept: { readonly ref: string; readonly keptLength: number } | undefined;
    if (run.store !== undefined) {
        const { session } = run;
        const ref = toolOutputRef(recordKeyFor(session, run.invocationId, toolCallId));
        const content = keptTextOf(text);
        // A run session carries the thread of the chat that started the run, but a run belongs to its analysis.
        const threadId = session.runFrame === undefined ? session.scope.threadId : undefined;
        const put = await run.store.put({
            analysisId: session.scope.analysisId,
            ref,
            toolName,
            toolCallId,
            content,
            totalLength: text.length,
            threadId,
        });
        if (put.isErr()) run.log.warn("tool output not kept", { toolName, toolCallId, ref, errorType: put.error.type });
        kept = { ref, keptLength: content.length };
    }
    const excerpt = excerptOf(text, kept);
    if (output.outcome === "error") return { outcome: "error", text: excerpt };
    const cut: { -readonly [K in keyof Extract<ToolCallOutput, { outcome: "ok" }>]: Extract<ToolCallOutput, { outcome: "ok" }>[K] } = {
        outcome: "ok",
        excerpt,
    };
    if (output.record !== undefined) cut.record = output.record;
    if (output.images !== undefined) cut.images = output.images;
    return cut;
}

/**
 * Log a tool failure. A `ToolError` is a failure that the tool modeled, thus its
 * own text is the account. Any other `Error` is a fault that the tool did not
 * model, and the log gets one warn.
 */
function logToolFailure(tool: Tool, toolCallId: string, failure: unknown, log: Logger): void {
    if (modeledToolError(failure) !== undefined) return;
    const failureError = errorOf(failure);
    if (failureError !== undefined) log.warn("tool call threw", { tool: tool.id, toolCallId, ...log.errorFields(failureError) });
}

/** The `ToolError` of a failure: the value itself, or the value that `unwrapOrThrow` wrapped in a `ResultError`. */
function modeledToolError(failure: unknown): ToolError | undefined {
    if (isToolError(failure)) return failure;
    return failure instanceof ResultError && isToolError(failure.value) ? failure.value : undefined;
}

/**
 * Normalize a tool's return value to plain JSON, stripping NUL from every string
 * it holds. The reviver sees values, not keys — a NUL in an object KEY would
 * still reach the row, but keys come from tool result types rather than scanned
 * bytes, so nothing produces one.
 */
function jsonValue(value: unknown): Json {
    // The stringify/parse round trip holds only JSON values, so the parse never
    // refuses; it moves the parser's `any` out of the tool-result field.
    // oxlint-disable-next-line eslint-js/no-restricted-syntax -- the NUL-stripping reviver walks a value this code serialized one line above, not text of unknown shape; a schema proves nothing here.
    const serialized: unknown = JSON.parse(JSON.stringify(value ?? null), (_key, v: unknown) => (typeof v === "string" ? stripNulCharacters(v) : v));
    return JsonSchema.parse(serialized);
}

// NUL is stripped from the prose BEFORE it is serialized: past the stringify it
// is the six-character escape \u0000 — legitimate JSON text, and no longer
// distinguishable from an error that happens to quote that escape.
function toolErrorContent(value: unknown): string {
    const toolError = modeledToolError(value);
    if (toolError !== undefined) {
        return JSON.stringify({ error: stripNulCharacters(toolError.error), retryable: toolError.retryable });
    }
    const { retryable } = classifyProviderError(value);
    const error = stripNulCharacters(errorMessageOf(value) ?? textOf(value));
    return JSON.stringify({ error, retryable });
}

/** The prose of a rejected approval is the only account that the model gets of the denial. */
export function deniedReason(feedback: string | undefined): string {
    return feedback === undefined || feedback.length === 0
        ? "The user rejected this action."
        : `The user rejected this action with the following feedback: ${feedback}`;
}

/**
 * The optional `detail` field, present only when there is one. Spread rather
 * than assigned so an undescribed call emits an event with no `detail` key at
 * all, which is what the contract promises: absent, never empty.
 */
function detailField(detail: ToolCallDetail | undefined): { detail?: ToolCallDetail } {
    return detail === undefined ? {} : { detail };
}

function formatZodIssues(error: z.ZodError, input: unknown): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            const hint = hintForZodIssue(issue, input);
            return hint === undefined ? `${path}: ${issue.message}` : `${path}: ${issue.message} — ${hint}`;
        })
        .join("; ");
}
