/**
 * The harness tool primitive.
 *
 * `defineTool` packages a `Tool` and emits its Anthropic `input_schema`
 * from the Zod `inputSchema` via Zod 4's native `z.toJSONSchema()`. It is
 * dependency-agnostic (see the harness-durable-runtime spec): a pure tool is a module-scope
 * `defineTool(...)`; a dependency-bearing tool is a factory closure that
 * captures its deps and calls `defineTool`.
 *
 * `ToolContext` carries exactly the three request-scoped values every tool
 * may need — no pool, no sandbox, no logger. The error contract: an expected
 * outcome ("not found", "no results") stays in the ok channel as a data
 * variant (`ok({ found: false })`); an unexpected failure is an `err(ToolError)`
 * or a throw. The loop (`dispatchTool`) owns the `is_error` envelope — it maps
 * both `err` and a thrown error to one `tool_result { is_error: true }`.
 */

import type { Result } from "neverthrow";
import { z } from "zod";

import type { AgentSession } from "../auth/types.js";
import type { EmitFn, RunStep } from "../loop/types.js";

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

/** Runtime guard — does a `Result`'s error value carry the `ToolError` shape? */
export function isToolError(value: unknown): value is ToolError {
    return typeof value === "object" && value !== null && typeof (value as ToolError).error === "string" && typeof (value as ToolError).retryable === "boolean";
}

/**
 * The request-scoped values passed to every tool's `execute`. No injected
 * dependencies (see the harness-durable-runtime spec) — `session`, `signal`, `emit`, plus the `runStep`
 * durability seam (`passthroughStep` in chat, `DBOS.runStep` in workflows)
 * a tool uses to wrap its own durable work.
 */
export interface ToolContext {
    readonly session: AgentSession;
    readonly signal: AbortSignal;
    readonly emit: EmitFn;
    /**
     * Wrap durable work in a replay-cached step. The loop namespaces the name
     * under the tool's own step name, so a tool just passes a short local label.
     * `bodyContext` tools (which run unwrapped in the workflow body — see `Tool`)
     * own their durability through this seam and their internal body calls.
     */
    readonly runStep: RunStep;
}

/**
 * A packaged tool: identity, the Zod input contract, the emitted Anthropic
 * `input_schema`, and the executor. The TypeScript return type of `execute`
 * is the output contract — Anthropic tools carry no output schema on the wire.
 */
export interface Tool<Input = unknown, Output = unknown> {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: z.ZodType;
    readonly jsonSchema: Record<string, unknown>;
    /**
     * Opt out of the loop's default `runStep` wrap (see the harness-tools spec). A `bodyContext`
     * tool runs unwrapped, in the workflow body, so its internal `DBOS.recv` /
     * `DBOS.writeStream` (body-only) calls are legal. Exactly the sandbox mutate
     * tools (`execute_command`, `write_file`, `edit_file`) carry it; they own
     * their own durability (submit is a step, recv is a body call). Default
     * (unset/false) keeps the wrap, so external-API tools cache on replay.
     */
    readonly bodyContext?: boolean;
    execute(input: Input, ctx: ToolContext): Promise<Result<Output, ToolError>>;
}

export interface ToolDefinition<Schema extends z.ZodType, Output> {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: Schema;
    /** See `Tool.bodyContext`. Opt out of the loop's default `runStep` wrap. */
    readonly bodyContext?: boolean;
    execute(input: z.infer<Schema>, ctx: ToolContext): Promise<Result<Output, ToolError>>;
}

/**
 * Package a `Tool`. The emitted JSON Schema must have a top-level
 * `"type": "object"` — Anthropic rejects anything else. A `z.discriminatedUnion`
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

    return {
        id: def.id,
        description: def.description,
        inputSchema: def.inputSchema,
        jsonSchema,
        ...(def.bodyContext === true ? { bodyContext: true } : {}),
        execute: def.execute,
    };
}
