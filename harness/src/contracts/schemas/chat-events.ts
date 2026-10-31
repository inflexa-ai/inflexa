/**
 * Zod schemas for chat-stream events — validation at boundaries.
 */

import { z } from "zod";

import { TokenUsageRollupSchema } from "./usage.js";

export const EventSourceSchema = z.object({
    agentId: z.string(),
    callPath: z.array(z.string()),
    invocationId: z.string().optional(),
});

export const TextDeltaEventSchema = z.object({
    type: z.literal("text-delta"),
    text: z.string(),
    source: EventSourceSchema,
});

export const IterationEventSchema = z.object({
    type: z.literal("iteration"),
    source: EventSourceSchema,
});

/** Mirrors the `ToolOutcome` union — three states, never a boolean. */
export const ToolOutcomeSchema = z.enum(["ok", "error", "denied"]);

/** Mirrors `ToolCallOutcome` — the live three plus the record-only `incomplete`. */
export const ToolCallOutcomeSchema = z.enum(["ok", "error", "denied", "incomplete"]);

/** The most named leaves that a `fields` value holds. */
export const TOOL_CALL_FIELDS_MAX = 4;

/** A field name has 1 to 40 characters of letters, digits, `_`, and `-`. */
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a bounded character class has no zod builtin.
export const ToolCallFieldNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);

/** A language has 1 to 20 characters of lowercase letters, digits, `+`, `#`, `.`, and `-`. */
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a bounded character class has no zod builtin.
export const ToolCallLanguageSchema = z.string().regex(/^[a-z0-9+#.-]{1,20}$/);

const TextLeafShape = { kind: z.literal("text"), text: z.string(), cut: z.boolean() };
const JsonLeafShape = { kind: z.literal("json"), text: z.string(), cut: z.boolean() };
const CodeLeafShape = { kind: z.literal("code"), language: ToolCallLanguageSchema, text: z.string(), cut: z.boolean() };

/** Mirrors `ToolCallLeaf`. */
export const ToolCallLeafSchema = z.discriminatedUnion("kind", [z.object(TextLeafShape), z.object(JsonLeafShape), z.object(CodeLeafShape)]);

const ToolCallFieldSchema = z.discriminatedUnion("kind", [
    z.object({ name: ToolCallFieldNameSchema, ...TextLeafShape }),
    z.object({ name: ToolCallFieldNameSchema, ...JsonLeafShape }),
    z.object({ name: ToolCallFieldNameSchema, ...CodeLeafShape }),
]);

/** Mirrors `ToolCallValue`. A `fields` value holds 1 to 4 leaves and no `fields` value. */
export const ToolCallValueSchema = z.discriminatedUnion("kind", [
    z.object(TextLeafShape),
    z.object(JsonLeafShape),
    z.object(CodeLeafShape),
    z.object({ kind: z.literal("fields"), fields: z.array(ToolCallFieldSchema).min(1).max(TOOL_CALL_FIELDS_MAX) }),
]);

export const ToolStartedEventSchema = z.object({
    type: z.literal("tool-started"),
    toolUseId: z.string(),
    name: z.string(),
    detail: z.string().optional(),
    input: ToolCallValueSchema.optional(),
    source: EventSourceSchema,
});

export const ToolFinishedEventSchema = z.object({
    type: z.literal("tool-finished"),
    toolUseId: z.string(),
    name: z.string(),
    outcome: ToolOutcomeSchema,
    detail: z.string().optional(),
    /** Optional and absent when unmeasured — never a zero in place of a figure. */
    durationMs: z.number().optional(),
    input: ToolCallValueSchema.optional(),
    result: ToolCallValueSchema.optional(),
    error: ToolCallValueSchema.optional(),
    source: EventSourceSchema,
});

export const FinishEventSchema = z.object({
    type: z.literal("finish"),
    source: EventSourceSchema,
    usage: TokenUsageRollupSchema.optional(),
    turnUsage: TokenUsageRollupSchema.optional(),
});

export const ChatErrorEventSchema = z.object({
    type: z.literal("error"),
    message: z.string(),
    reason: z.string().optional(),
    source: EventSourceSchema,
});

export const MessageStartEventSchema = z.discriminatedUnion("role", [
    z.object({
        type: z.literal("message-start"),
        messageId: z.uuid(),
        role: z.literal("user"),
        text: z.string(),
        source: EventSourceSchema,
    }),
    z.object({
        type: z.literal("message-start"),
        messageId: z.uuid(),
        role: z.literal("assistant"),
        source: EventSourceSchema,
    }),
]);

export const ChatEventSchema = z.discriminatedUnion("type", [
    TextDeltaEventSchema,
    IterationEventSchema,
    ToolStartedEventSchema,
    ToolFinishedEventSchema,
    FinishEventSchema,
    ChatErrorEventSchema,
    MessageStartEventSchema,
]);
