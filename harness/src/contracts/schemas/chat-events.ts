/**
 * Zod schemas for Cortex-native chat-stream events — validation at boundaries.
 */

import { z } from "zod";

import { TokenUsageRollupSchema } from "./usage.js";

export const EventSourceSchema = z.object({
    agentId: z.string(),
    callPath: z.array(z.string()),
});

export const TextDeltaEventSchema = z.object({
    type: z.literal("text-delta"),
    text: z.string(),
    source: EventSourceSchema,
});

/** Mirrors the `ToolOutcome` union — three states, never a boolean. */
export const ToolOutcomeSchema = z.enum(["ok", "error", "denied"]);

export const ToolStartedEventSchema = z.object({
    type: z.literal("tool-started"),
    toolUseId: z.string(),
    name: z.string(),
    detail: z.string().optional(),
    source: EventSourceSchema,
});

export const ToolFinishedEventSchema = z.object({
    type: z.literal("tool-finished"),
    toolUseId: z.string(),
    name: z.string(),
    outcome: ToolOutcomeSchema,
    detail: z.string().optional(),
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

export const CortexChatEventSchema = z.discriminatedUnion("type", [
    TextDeltaEventSchema,
    ToolStartedEventSchema,
    ToolFinishedEventSchema,
    FinishEventSchema,
    ChatErrorEventSchema,
]);
