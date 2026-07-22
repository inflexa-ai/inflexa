import { modelMessageSchema, type ModelMessage } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { z } from "zod";

export const SUPPORTED_AI_SDK_MAJOR = 7;

export const StoredMessageEnvelopeSchema = z.object({
    kind: z.literal("ai-sdk-model-message"),
    aiSdkMajor: z.literal(SUPPORTED_AI_SDK_MAJOR),
    message: modelMessageSchema,
});

export type StoredMessageEnvelope = z.infer<typeof StoredMessageEnvelopeSchema>;

export function envelopeMessage(message: ModelMessage): StoredMessageEnvelope {
    return {
        kind: "ai-sdk-model-message",
        aiSdkMajor: SUPPORTED_AI_SDK_MAJOR,
        message,
    };
}

export function parseStoredMessageEnvelope(value: unknown, identity: string): StoredMessageEnvelope {
    const parsed = StoredMessageEnvelopeSchema.safeParse(value);
    if (!parsed.success) {
        throw new Error(`Invalid stored AI SDK message envelope at ${identity}: ${parsed.error.message}`);
    }
    return parsed.data;
}

/**
 * The `providerOptions` namespace the harness stamps its OWN message metadata into.
 *
 * A provider SDK reads only its own namespace (`anthropic`, `openai`, …) and ignores every other key, so
 * a harness-owned namespace rides to the wire and back untouched; `modelMessageSchema` validates
 * `providerOptions` structurally rather than against a list of known namespaces, so it also survives the
 * storage envelope round-trip. That round-trip is the whole reason the marker lives here rather than on
 * the envelope: readers of STORED rows need it, and `ModelMessage` offers no other field able to carry a
 * harness fact from the loop, through `appendTurn`, into a row.
 */
export const HARNESS_PROVIDER_NAMESPACE = "cortex";

/** The {@link HARNESS_PROVIDER_NAMESPACE} key marking a message the loop synthesized rather than one a human sent. */
export const SYNTHETIC_MESSAGE_KEY = "synthetic";

/**
 * Build a `user` message the agent loop synthesized — today, the nudge that continues a reply the model
 * truncated at its output-token limit.
 *
 * It has to carry the `user` role because the wire format requires a user turn after a truncated
 * assistant message, but it is not user input, and the difference is load-bearing: a `user` message is
 * what OPENS a conversation turn, so an unmarked synthetic one reads as a spurious turn boundary —
 * splitting one turn into two for the token window and, worse, giving a tail-turn removal a cut point in
 * the middle of a turn. Marking it is what lets {@link isSyntheticUserMessage} keep those readers honest.
 */
export function syntheticUserMessage(text: string): ModelMessage {
    return {
        role: "user",
        content: text,
        providerOptions: { [HARNESS_PROVIDER_NAMESPACE]: { [SYNTHETIC_MESSAGE_KEY]: true } },
    };
}

/** Whether the loop synthesized this message (see {@link syntheticUserMessage}) rather than a human sending it. */
export function isSyntheticUserMessage(message: ModelMessage): boolean {
    return message.providerOptions?.[HARNESS_PROVIDER_NAMESPACE]?.[SYNTHETIC_MESSAGE_KEY] === true;
}

type LegacyContent = string | Array<Record<string, unknown>>;

export interface LegacyMessageRow {
    readonly threadId: string;
    readonly seq: number;
    readonly role: string;
    readonly content: LegacyContent;
}

function providerOptionsFromLegacy(block: Record<string, unknown>): ProviderOptions | undefined {
    // A block may carry both a signed thinking signature and cache_control;
    // both are required for valid continuation, so both must survive.
    const anthropic: Record<string, unknown> = {};
    if (typeof block.signature === "string") anthropic.signature = block.signature;
    if (typeof block.cache_control === "object" && block.cache_control !== null) {
        anthropic.cacheControl = block.cache_control;
    }
    return Object.keys(anthropic).length > 0 ? ({ anthropic } as ProviderOptions) : undefined;
}

export function legacyAnthropicToModelMessage(row: LegacyMessageRow): ModelMessage {
    const content = row.content;
    if (row.role === "user") {
        if (typeof content === "string") return { role: "user", content };
        const toolResults = content.filter((block) => block.type === "tool_result");
        if (toolResults.length > 0) {
            // An AI SDK tool message carries only tool-result parts; a legacy row
            // mixing tool_result with other blocks cannot become one message and
            // must fail the row rather than drop the extra blocks.
            if (toolResults.length !== content.length) {
                throw new Error(`Legacy user row ${row.threadId}/${row.seq} mixes tool_result with other content blocks and cannot be represented losslessly`);
            }
            return {
                role: "tool",
                content: toolResults.map((block) => {
                    const toolCallId = block.tool_use_id;
                    if (typeof toolCallId !== "string") throw new Error(`Legacy tool_result row ${row.threadId}/${row.seq} is missing tool_use_id`);
                    const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? null);
                    return {
                        type: "tool-result",
                        toolCallId,
                        toolName: typeof block.name === "string" ? block.name : "legacy_tool",
                        output: block.is_error === true ? { type: "error-text", value: raw } : { type: "text", value: raw },
                    };
                }),
            };
        }
        const unrepresentable = content.find((block) => !(block.type === "text" && typeof block.text === "string"));
        if (unrepresentable !== undefined) {
            throw new Error(
                `Legacy user row ${row.threadId}/${row.seq} contains unrepresentable block type "${String(unrepresentable.type)}"; failing rather than writing a lossy envelope`,
            );
        }
        const userContent = content.map((block) => ({ type: "text" as const, text: String(block.text), providerOptions: providerOptionsFromLegacy(block) }));
        return {
            role: "user",
            content: userContent as Extract<ModelMessage, { role: "user" }>["content"],
        };
    }

    if (row.role === "assistant") {
        if (typeof content === "string") return { role: "assistant", content };
        const assistantContent: unknown[] = [];
        for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
                assistantContent.push({ type: "text" as const, text: block.text, providerOptions: providerOptionsFromLegacy(block) });
                continue;
            }
            if (block.type === "thinking" && typeof block.thinking === "string") {
                assistantContent.push({ type: "reasoning" as const, text: block.thinking, providerOptions: providerOptionsFromLegacy(block) });
                continue;
            }
            if (block.type === "tool_use") {
                if (typeof block.id !== "string" || typeof block.name !== "string") {
                    throw new Error(`Legacy tool_use row ${row.threadId}/${row.seq} is missing id/name`);
                }
                assistantContent.push({
                    type: "tool-call" as const,
                    toolCallId: block.id,
                    toolName: block.name,
                    input: block.input ?? {},
                    providerOptions: providerOptionsFromLegacy(block),
                });
                continue;
            }
            // Any other block (e.g. redacted_thinking) may carry signed provider
            // data required for continuation; fail the row instead of dropping it.
            throw new Error(
                `Legacy assistant row ${row.threadId}/${row.seq} contains unrepresentable block type "${String(block.type)}"; failing rather than writing a lossy envelope`,
            );
        }
        return {
            role: "assistant",
            content: assistantContent as Extract<ModelMessage, { role: "assistant" }>["content"],
        };
    }

    if (row.role === "system") {
        if (typeof content !== "string") throw new Error(`Legacy system row ${row.threadId}/${row.seq} must contain string content`);
        return { role: "system", content };
    }

    throw new Error(`Unsupported legacy message role at ${row.threadId}/${row.seq}: ${row.role}`);
}
