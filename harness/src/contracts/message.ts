/**
 * Cortex-owned chat message types — the wire shape, the in-memory shape,
 * and the public API for everything the chat path exchanges.
 *
 * No AI SDK types appear here or anywhere else in the package. The
 * discriminant is `type`, so `switch (part.type) { case "data-report-preview": ... }`
 * narrows the union member without any `as` cast.
 */

import type { CortexChatPart } from "./chat-parts.js";

/** A plain assistant/user text run. */
export interface TextPart {
    type: "text";
    text: string;
}

/**
 * A tool call observed during the turn (or replayed from history).
 *
 * Live frames collapse a `tool-started`+`tool-finished` pair into a single
 * part keyed by `toolCallId`. History-replayed calls always arrive with
 * `status: "finished"`.
 */
export interface ToolCallPart {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    status: "started" | "finished";
    isError?: boolean;
}

/** The discriminated union of every part the chat path can carry. */
export type CortexPart = TextPart | ToolCallPart | CortexChatPart;

/** A single chat message — user, assistant, or system. */
export interface CortexMessage {
    id: string;
    role: "user" | "assistant" | "system";
    parts: CortexPart[];
    /**
     * Set when this message's production was cut off by a client abort, so the UI
     * can badge it. Absent means not interrupted — the field is optional so every
     * existing consumer is unaffected.
     */
    interrupted?: boolean;
}
