/**
 * Cortex-owned chat message types — the wire shape, the in-memory shape,
 * and the public API for everything the chat path exchanges.
 *
 * No AI SDK types appear here or anywhere else in the package. The
 * discriminant is `type`, so `switch (part.type) { case "data-report-preview": ... }`
 * narrows the union member without any `as` cast.
 */

import type { ToolCallDetail, ToolCallOutcome } from "./chat-events.js";
import type { CortexChatPart } from "./chat-parts.js";
import type { TokenUsageRollup } from "./usage.js";

/** A plain assistant/user text run. */
export interface TextPart {
    type: "text";
    text: string;
}

/**
 * A tool call observed during the turn (or replayed from history).
 *
 * Live frames collapse a `tool-started`+`tool-finished` pair into a single part
 * keyed by `toolCallId`.
 *
 * `outcome` carries the call's whole terminal state in one field, and its absence
 * means exactly one thing: the call is still in flight. A REPLAYED call therefore
 * always has one — a turn cut off mid-call replays as `incomplete`, not as an
 * absent outcome a reader would have to interpret. That is what lets a consumer
 * switch on this single field and be told by the compiler when it misses a case,
 * rather than each host inventing what "no outcome" means and disagreeing.
 */
export interface ToolCallPart {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    /**
     * How the call ended. Absent ONLY while the call is in flight on a live
     * surface; every replayed call carries one. See {@link ToolCallOutcome}.
     */
    outcome?: ToolCallOutcome;
    /** See {@link ToolCallDetail}. Absent when no detail was produced. */
    detail?: ToolCallDetail;
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
    /**
     * What providers reported for the TURN this message completed — the same
     * figure `FinishEvent.turnUsage` carries to a live surface, so a reloaded
     * transcript renders what the live turn rendered. Carried only on the
     * assistant message that ended a turn.
     *
     * Absent means no figure was reported: a turn whose calls reported nothing, a
     * message stored before rollups were persisted, or any message that did not
     * end a turn. Never an all-zero rollup — "spent nothing" and "was told
     * nothing" stay distinguishable.
     */
    usage?: TokenUsageRollup;
}
