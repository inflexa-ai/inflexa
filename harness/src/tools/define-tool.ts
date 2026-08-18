/**
 * The harness tool primitive.
 *
 * `defineTool` packages a `Tool` and emits its AI SDK input schema
 * from the Zod `inputSchema` via Zod 4's native `z.toJSONSchema()`. It is
 * dependency-agnostic (see the harness-durable-runtime spec): a pure tool is a module-scope
 * `defineTool(...)`; a dependency-bearing tool is a factory closure that
 * captures its deps and calls `defineTool`.
 *
 * `ToolContext` carries only request-scoped values every tool may need
 * (`invocationId`, `session`, `signal`, `emit`, `runStep`, `ask`, `turnUsage`) — no pool, no sandbox, no
 * logger. The error contract: an expected
 * outcome ("not found", "no results") stays in the ok channel as a data
 * variant (`ok({ found: false })`); an unexpected failure is an `err(ToolError)`
 * or a throw. The loop (`dispatchTool`) owns the `is_error` envelope — it maps
 * both `err` and a thrown error to one `tool_result { is_error: true }`.
 */

import type { Result } from "neverthrow";
import { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import type { AgentRunUsage } from "../loop/metrics.js";
import type { EmitFn, RunStep } from "../loop/types.js";
import type { AskApproval, AskRequest } from "./approval/contract.js";

export type { EmitFn };

/**
 * The error channel of a tool's `Result`. `error` is the message surfaced to
 * the model in the `is_error` `tool_result`; `retryable` tells it whether
 * re-issuing the call could plausibly succeed; `cause` keeps the underlying
 * value for classification if the error is later rethrown. A tool rarely
 * builds one by hand — most failures stay thrown and the loop's backstop
 * derives the same shape via `classifyProviderError`.
 */
export interface ToolError {
    readonly error: string;
    readonly retryable: boolean;
    readonly cause?: unknown;
}

export type ToolExecutionMode = "step" | "workflow" | "inline";

/** Runtime guard — does a `Result`'s error value carry the `ToolError` shape? */
export function isToolError(value: unknown): value is ToolError {
    return typeof value === "object" && value !== null && typeof (value as ToolError).error === "string" && typeof (value as ToolError).retryable === "boolean";
}

/**
 * One picture that a tool ok value carries beside its JSON data. `base64` holds
 * the bytes, and `mediaType` names the IANA type, for example "image/png". The
 * loop splits each picture out of the JSON text, and it rides the tool result as
 * an image content block. Thus the model sees the picture, and the JSON text
 * holds no bytes.
 */
export interface ToolResultImage {
    readonly base64: string;
    readonly mediaType: string;
}

/**
 * The reserved key that carries the pictures on a tool ok value. It is a symbol,
 * thus it never collides with a data field. `JSON.stringify` also omits a symbol
 * key, thus the bytes never reach the JSON text by accident.
 */
export const toolResultImageKey: unique symbol = Symbol("toolResultImage");

/** A tool ok value that can carry one picture or an ordered list of them under the reserved key. */
export type WithToolResultImage<T> = T & { readonly [toolResultImageKey]?: ToolResultImage | readonly ToolResultImage[] };

/**
 * Attach one picture to a tool ok value. The value keeps its own fields, and the
 * picture rides under the reserved key. The loop reads the key, and it moves the
 * bytes into an image content block on the tool result.
 */
export function withToolResultImage<T extends object>(value: T, image: ToolResultImage): WithToolResultImage<T> {
    return { ...value, [toolResultImageKey]: image };
}

/**
 * Attach an ordered list of pictures to a tool ok value. The order is the order
 * that the model reads, and the loop keeps it on the wire. A tool that slices a
 * page attaches the slices in document order.
 */
export function withToolResultImages<T extends object>(value: T, images: readonly ToolResultImage[]): WithToolResultImage<T> {
    return { ...value, [toolResultImageKey]: images };
}

/** Does one entry under the reserved key carry the picture shape? */
function isToolResultImage(entry: unknown): entry is ToolResultImage {
    if (typeof entry !== "object" || entry === null) return false;
    const { base64, mediaType } = entry as Partial<ToolResultImage>;
    return typeof base64 === "string" && typeof mediaType === "string";
}

/**
 * Read the pictures that a tool ok value carries, in order. A value with none
 * gives the empty list. The one-picture shape reads as a list of one, thus a
 * tool that attaches one picture and a tool that attaches a list meet the loop
 * in the same shape.
 */
export function readToolResultImages(value: unknown): ToolResultImage[] {
    if (typeof value !== "object" || value === null) return [];
    const carried = (value as { [toolResultImageKey]?: unknown })[toolResultImageKey];
    const entries = Array.isArray(carried) ? carried : [carried];
    return entries.filter(isToolResultImage);
}

/**
 * The request-scoped values passed to every tool's `execute`. No injected
 * dependencies (see the harness-durable-runtime spec) — invocation identity,
 * `session`, `signal`, `emit`, the `runStep`
 * durability seam (`passthroughStep` in chat, `DBOS.runStep` in workflows) a
 * tool uses to wrap its own durable work, the `ask` user-approval seam, and the
 * turn's usage accumulator a sub-agent-running tool hands to its child loop.
 */
export interface ToolContext {
    /** Stable identity of this AI SDK tool call. Redelivery preserves it; a new
     * model-issued call receives a new value. */
    readonly invocationId: string;
    readonly session: AgentSession;
    readonly signal: AbortSignal;
    readonly emit: EmitFn;
    /**
     * Wrap durable work in a replay-cached step. The loop namespaces the name
     * under the tool's own step name, so a tool just passes a short local label.
     */
    readonly runStep: RunStep;
    /**
     * Pause for an explicit user decision on a concrete action. Resolves with the
     * approval (`once`/`always`) or throws `AskRejectedError` on denial. Resolves
     * to a deny-by-default realization when the embedder wires none, so a tool
     * that calls it in a non-interactive context is denied rather than left
     * waiting on a surface that cannot answer.
     */
    readonly ask: (request: AskRequest) => Promise<AskApproval>;
    /**
     * The turn's usage accumulator — the mutable total every loop under this
     * turn folds its LLM calls into. A tool that drives a child `runAgent`
     * passes it straight into that run's options, which is what puts the
     * child's tokens in the turn total its root loop reports. A tool that runs
     * no child agent ignores it.
     */
    readonly turnUsage?: AgentRunUsage;
}

/**
 * A packaged tool: identity, the Zod input contract, the emitted AI SDK input
 * schema, execution mode, the optional call-description hook, and the executor.
 */
export interface Tool<Input = unknown, Output = unknown> {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: z.ZodType;
    readonly jsonSchema: Record<string, unknown>;
    readonly executionMode: ToolExecutionMode;
    /** See {@link ToolDefinition.describeCall}. Absent when the tool declares none. */
    describeCall?(input: Input): string;
    /** See {@link ToolDefinition.describeResult}. Absent when the tool declares none. */
    describeResult?(input: Input, result: Output): string;
    execute(input: Input, ctx: ToolContext): Promise<Result<Output, ToolError>>;
}

export interface ToolDefinition<Schema extends z.ZodType, Output> {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: Schema;
    readonly executionMode?: ToolExecutionMode;
    /**
     * One line that names what THIS call does — the call-time counterpart of
     * `description`. `description` self-describes the tool at attach time, so an
     * agent knows what it holds. `describeCall` self-describes one invocation, so
     * a surface can render four `update_working_memory` calls as four distinct
     * lines instead of four identical chips.
     *
     * The decision is REQUIRED. Give a hook, or give the literal `"none"`.
     * `"none"` declares that the input of the tool cannot distinguish its calls,
     * thus a hook can only restate the name of the tool. `defineTool` consumes
     * the sentinel at construction, and the sentinel never reaches a packaged
     * tool. Thus a reader of a `Tool` sees a function, or sees nothing. A hook
     * that returns the string `"none"` is still a hook, because the discriminator
     * is `typeof`, not equality.
     *
     * A hook lives here, beside `inputSchema`, because that is the one place
     * where the compiler checks the two against each other. A host-side formatter
     * that reads `input.path` by string key breaks silently the day the schema
     * moves. This one fails to build. The tool author writes it, because the tool
     * author knows which field matters.
     *
     * A hook is synchronous and pure — no I/O, no ambient state. Dispatch is what
     * the user waits on, and a description must never fail a call: the loop
     * validates the input against `inputSchema` first, guards the call, and drops
     * the detail on any failure (see the tool-call-detail capability).
     *
     * Return whatever reads best. Normalization — one line, control characters
     * removed, secrets redacted, length capped — happens once at the emit site,
     * never here.
     *
     * The hook never reaches the model.
     */
    describeCall: ((input: z.infer<Schema>) => string) | "none";
    /**
     * One line that names what THIS call PRODUCED — the outcome-time counterpart
     * of `describeCall`. A page path, a recorded id, and a listed count are facts
     * of the result, thus no hook over the input can name one. The finished event
     * carries this line, and it carries the call detail when the hook gives
     * nothing.
     *
     * The decision is OPTIONAL, unlike `describeCall`. A call always has an input
     * to describe or an input that cannot distinguish it, thus that decision is
     * forced. A result is different: a tool whose ok value adds no fact that a
     * reader wants leaves the call detail to stand for the whole call. Thus the
     * absent key is the whole of "this tool describes no result", and the `"none"`
     * sentinel has no counterpart here.
     *
     * The hook runs on an ok outcome only. An error outcome already names itself,
     * and a hook over a failed call reads a shape that does not exist.
     *
     * A hook is synchronous and pure — no I/O, no ambient state — and a
     * description must never fail a call: the loop guards the call and drops the
     * detail on any failure (see the tool-call-detail capability). The result
     * arrives as the tool produced it, thus the hook reads a value of its own
     * declared `Output` type and no parse stands between the two.
     *
     * Return whatever reads best. Normalization — one line, control characters
     * removed, secrets redacted, length capped — happens once at the emit site,
     * never here.
     *
     * The hook never reaches the model.
     */
    readonly describeResult?: (input: z.infer<Schema>, result: Output) => string;
    execute(input: z.infer<Schema>, ctx: ToolContext): Promise<Result<Output, ToolError>>;
}

/**
 * Package a `Tool`. The emitted JSON Schema must have a top-level
 * `"type": "object"` — model tool calling rejects anything else. A `z.discriminatedUnion`
 * emits a top-level `oneOf`; this throws at construction (fail fast — not at
 * the first LLM call). Union-shaped inputs must be modelled as a flat object
 * with a discriminator field.
 */
export function defineTool<Schema extends z.ZodType, Output>(def: ToolDefinition<Schema, Output>): Tool<z.infer<Schema>, Output> {
    const jsonSchema = z.toJSONSchema(def.inputSchema) as Record<string, unknown>;
    delete jsonSchema.$schema;

    if (jsonSchema.type !== "object") {
        throw new Error(
            `defineTool("${def.id}"): inputSchema must emit a top-level JSON Schema ` +
                `'"type":"object"', got ${JSON.stringify(jsonSchema.type)}. ` +
                `Union-shaped inputs (z.discriminatedUnion) emit "oneOf" with no ` +
                `top-level "type" — model the input as a flat object with a ` +
                `discriminator field instead.`,
        );
    }

    const executionMode: ToolExecutionMode = def.executionMode ?? "step";

    return {
        id: def.id,
        description: def.description,
        inputSchema: def.inputSchema,
        jsonSchema,
        executionMode,
        // Spread rather than assigned: a tool that declines carries no
        // `describeCall` key at all, so "has a hook" is one property check.
        // `typeof` is the discriminator, not equality with the sentinel, so a
        // hook that returns the string `"none"` still packages as a hook.
        ...(typeof def.describeCall === "function" ? { describeCall: def.describeCall } : {}),
        // The same property-presence pattern as `describeCall`: a tool that
        // declares no result hook carries no key, thus "has a hook" is one
        // property check on either side.
        ...(typeof def.describeResult === "function" ? { describeResult: def.describeResult } : {}),
        execute: def.execute,
    };
}
