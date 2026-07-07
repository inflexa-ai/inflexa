/**
 * Structured-output LLM helper for the target-assessment DBOS workflow.
 *
 * Uses a tool-choice forcing pattern: a single Anthropic tool named `submit`
 * carries the Zod schema as its `input_schema`, and
 * `tool_choice: { type: "tool", name: "submit" }` forces the model to fill
 * it. The tool's `input` IS the structured output.
 *
 * This intentionally does NOT pull in the harness `runAgent` loop — Phase-2
 * decisions are zero-tool single-shot calls. Phase-5 syntheses today use
 * regulatory-guidance + approval-precedent retrieval tools; the harness
 * port drops those grounding tools (PR #4 ships single-shot synthesis; a
 * follow-up may reintroduce the retrieval tools through the agent loop).
 *
 * Calls are routed through `runLlmStep`, so each LLM call lives in its own
 * `DBOS.runStep({name})` cache slot and a billing-gateway 402 self-cancels the
 * workflow rather than returning a coverage envelope.
 */

import { jsonSchema, tool as aiTool, type ToolCallPart } from "ai";
import { z } from "zod";

import type { AgentSession } from "../../../auth/types.js";
import type { AgentChat, ChatRequest } from "../../../providers/types.js";

import { BUDGET_EXCEEDED_SENTINEL, runLlmStep, type RunLlmStepResult } from "./llm-step.js";

const SUBMIT_TOOL_NAME = "submit";

export interface StructuredLlmCallOptions<TSchema extends z.ZodType> {
    /** Attempt-numbered durable-step name (e.g. `"ta-decision:modulator-triage:0"`). */
    readonly stepName: string;
    /** Agent id stamped on telemetry and billing-gateway provenance. */
    readonly agentId: string;
    readonly provider: AgentChat;
    readonly session: AgentSession;
    readonly system: string;
    readonly prompt: string;
    readonly schema: TSchema;
    readonly model: string;
    readonly signal?: AbortSignal;
}

export type StructuredLlmResult<TSchema extends z.ZodType> =
    { readonly kind: "ok"; readonly value: z.infer<TSchema> } | { readonly kind: "budget-exceeded"; readonly sentinel: typeof BUDGET_EXCEEDED_SENTINEL };

/**
 * Thrown when the model returned a structured-output payload that does
 * not parse against the declared Zod schema. The caller decides whether
 * to wrap as `coverage: "queried_no_data"` or rethrow as a hard failure.
 */
export class StructuredOutputParseError extends Error {
    constructor(
        message: string,
        readonly cause?: unknown,
    ) {
        super(message);
        this.name = "StructuredOutputParseError";
    }
}

/**
 * Convert a Zod schema to the JSON Schema shape Anthropic accepts as
 * `tool.input_schema`. Strips `$schema` (Anthropic rejects it) and asserts
 * a top-level `"type": "object"` (Anthropic rejects oneOf at the root).
 */
function schemaToJsonSchema(schema: z.ZodType, stepName: string): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
    delete jsonSchema.$schema;

    if (jsonSchema.type !== "object") {
        throw new Error(`structuredLlmCall(${stepName}): schema must emit top-level "type":"object", ` + `got ${JSON.stringify(jsonSchema.type)}`);
    }
    // `z.toJSONSchema()` returns an untyped JSON-schema object; it is structurally
    // Anthropic's `input_schema` once the top-level `type:"object"` check above passes
    // (the one shape Anthropic requires), which is the invariant making this cast safe.
    return jsonSchema;
}

function extractToolUseInput(blocks: readonly unknown[]): unknown | undefined {
    for (const block of blocks) {
        const part = block as Partial<ToolCallPart>;
        if (part.type === "tool-call" && part.toolName === SUBMIT_TOOL_NAME) {
            return part.input;
        }
    }
    return undefined;
}

/**
 * Run one structured-output LLM call. Forces the model to call the
 * `submit` tool whose input schema is `opts.schema`; parses the tool
 * input via `safeParse` and returns the typed value. A billing-gateway 402 returns
 * the budget-exceeded sentinel; non-402 throws + parse errors throw.
 */
export async function structuredLlmCall<TSchema extends z.ZodType>(opts: StructuredLlmCallOptions<TSchema>): Promise<StructuredLlmResult<TSchema>> {
    const inputSchema = schemaToJsonSchema(opts.schema, opts.stepName);

    const req: ChatRequest = {
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
        tools: {
            [SUBMIT_TOOL_NAME]: aiTool({
                description: `Submit the structured output. Call this tool exactly once with the final answer.`,
                inputSchema: jsonSchema(inputSchema),
            }),
        },
        toolChoice: { type: "tool", toolName: SUBMIT_TOOL_NAME },
    };

    const result: RunLlmStepResult = await runLlmStep({
        stepName: opts.stepName,
        agentId: opts.agentId,
        provider: opts.provider,
        req,
        session: opts.session,
        signal: opts.signal,
    });

    if (result.kind === "budget-exceeded") {
        return result;
    }

    const content = result.response.message.content;
    const raw = extractToolUseInput(Array.isArray(content) ? content : []);
    if (raw === undefined) {
        throw new StructuredOutputParseError(`structuredLlmCall(${opts.stepName}): model returned no submit tool_use block`);
    }

    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) {
        throw new StructuredOutputParseError(
            `structuredLlmCall(${opts.stepName}): submit payload failed schema validation: ${parsed.error.message}`,
            parsed.error,
        );
    }
    return { kind: "ok", value: parsed.data };
}
