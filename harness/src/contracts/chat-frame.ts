// The one translation path of a chat stream. Browser-safe: each import from outside `contracts/` is a type import.

import type { ChatDataPart, EmitEvent } from "../loop/types.js";
import { z } from "zod";
import type { ChatStreamEvent } from "../providers/types.js";
import type { ChatErrorEvent, ChatFrame, ChatPartFrame, EventSource, FinishEvent, IterationEvent, MessageStartEvent } from "./chat-events.js";
import type { KnownChatPart } from "./chat-parts.js";
import type { ChatMessage, MessagePart, TextPart, ToolCallPart } from "./message.js";
import { isKnownPartType, isReconciling } from "./part-registry.js";
import { EventSourceSchema } from "./schemas/chat-events.js";
import { ChatPartSchema } from "./schemas/chat-parts.js";
import type { TokenUsageRollup } from "./usage.js";

export type TurnTerminal = null | "finish" | { error: ChatErrorEvent };

export type ApplyFrameResult = {
    messages: ChatMessage[];
    terminal: TurnTerminal;
};

export type ChatPartCheck = { readonly ok: true; readonly frame: ChatPartFrame } | { readonly ok: false; readonly error: string };

/** The module imports no value from outside `contracts/` (browser-safe), so the generic record schema lives here. */
const UnknownRecordSchema = z.record(z.string(), z.unknown());

const ChatPartFrameSchema = z.looseObject({ type: z.templateLiteral(["data-", z.string()]), source: EventSourceSchema.optional() });

/**
 * The frame that {@link ChatPartFrameSchema} checked, given back as it arrived. The parse rebuilds the
 * record and strips each field of `source` that the source schema does not know, but the passthrough
 * contract of a type the registry does not know is byte for byte, so the arm returns the original
 * record and not the parse's copy of it.
 */
const UnchangedFrameSchema = z.custom<ChatPartFrame>((value) => ChatPartFrameSchema.safeParse(value).success);

function toSource(source: EmitEvent["source"]): EventSource {
    const frame: EventSource = { agentId: source.agentId, callPath: [...source.callPath] };
    if (source.invocationId !== undefined) frame.invocationId = source.invocationId;
    return frame;
}

/**
 * The wire shape of a data part, `{ ...data, type }`, which is the flat shape of the part contracts. The chat stream
 * and the run streams use this one rule.
 */
export function flattenDataPart(part: Pick<ChatDataPart, "type" | "data">): { type: `data-${string}` } & Record<string, unknown> {
    // The payload is `unknown`, and the spread is not checked here. The chat stream checks each frame with `checkChatPart`.
    // On the run stream the producer builds the payload with the fields of its part contract, and the synthesis-sink test
    // parses the result with `RunSynthesisPartSchema`.
    const data = UnknownRecordSchema.safeParse(part.data ?? {});
    let payload: Record<string, unknown> = {};
    if (data.success) payload = data.data;
    return { ...payload, type: part.type };
}

/**
 * The frame of one emitted event, or `null` for an `iteration` of the root agent. A frame of a sub-agent
 * keeps its source, thus a consumer can filter it. A `text-delta` has no source, thus its frame gets `fallbackSource`,
 * the source of the root agent. A part frame is not checked here: {@link checkChatPart} checks it where it arrives.
 */
export function toChatFrame(event: EmitEvent | ChatStreamEvent | ChatDataPart, fallbackSource: EmitEvent["source"]): ChatFrame | null {
    switch (event.type) {
        case "iteration":
            // The root loop gives none: a consumer of the root frames, for example the first-frame time of a
            // browser, must not read the start of a model request as output.
            return event.source.callPath.length > 1 ? { type: "iteration", source: toSource(event.source) } : null;

        case "tool-started":
            return {
                type: "tool-started",
                toolUseId: event.toolUseId,
                name: event.name,
                detail: event.detail,
                source: toSource(event.source),
            };

        case "tool-finished":
            return {
                type: "tool-finished",
                toolUseId: event.toolUseId,
                name: event.name,
                outcome: event.outcome,
                detail: event.detail,
                durationMs: event.durationMs,
                source: toSource(event.source),
            };

        case "text-delta":
            return { type: "text-delta", text: event.text, source: toSource(fallbackSource) };

        case "message-start":
            return { type: "message-start", messageId: event.messageId, role: event.role, source: toSource(event.source) };

        default: {
            const part = flattenDataPart(event);
            return { ...part, source: event.source === undefined ? undefined : toSource(event.source) };
        }
    }
}

/**
 * Check a part frame against the schema of its type, one time, where it arrives. The schema drops a field that it
 * does not know. A type that the registry does not know passes unchanged, because a newer emitter can send it. The
 * source is checked for each type, because {@link isRootFrame} reads its call path.
 */
export function checkChatPart(value: unknown): ChatPartCheck {
    const frame = ChatPartFrameSchema.safeParse(value);
    if (!frame.success) return { ok: false, error: frame.error.message };
    const { source, ...part } = frame.data;
    if (!isKnownPartType(frame.data.type)) return { ok: true, frame: UnchangedFrameSchema.parse(value) };
    const parsed = ChatPartSchema.safeParse(part);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    return { ok: true, frame: source === undefined ? parsed.data : { ...parsed.data, source } };
}

/**
 * Whether the frame is a part whose type the registry knows. The guard narrows by the registry key alone
 * and does not re-validate the payload. That is safe on the arrival path only: the payload of a known part
 * was schema-checked by {@link checkChatPart} where the frame arrived, so a frame that passed the check
 * and holds a known key carries the checked part with the source it arrived with.
 */
export function isKnownPartFrame(frame: ChatPartFrame): frame is KnownChatPart & { source?: EventSource } {
    return isKnownPartType(frame.type);
}

/** A frame of the root agent of a chat turn, whose call path is `[agent.id]`. A longer path is a sub-agent. */
export function isRootFrame(frame: ChatFrame): boolean {
    return frame.source === undefined || frame.source.callPath.length <= 1;
}

/**
 * The key that a part reconciles on: a tool call by its call id, and a part of a `reconciling` type by its type and
 * id. A part with no key always appends. The type is part of the key, because an id is unique only in its own type.
 */
export function reconcileKey(part: MessagePart): string | undefined {
    if (part.type === "tool-call") return `tool-call:${part.toolCallId}`;
    if (part.type === "text" || !isKnownPartType(part.type) || !isReconciling(part.type)) return undefined;
    return "id" in part && typeof part.id === "string" ? `${part.type}:${part.id}` : undefined;
}

/** Add a part, or replace the part with the same {@link reconcileKey} in the position of that part. */
export function upsertPart(parts: readonly MessagePart[], part: MessagePart): MessagePart[] {
    const key = reconcileKey(part);
    const index = key === undefined ? -1 : parts.findIndex((candidate) => reconcileKey(candidate) === key);
    if (index === -1) return [...parts, part];
    const next = parts.slice();
    next[index] = part;
    return next;
}

/** Apply one frame to the messages of a live turn, with no change to the input. A frame of a sub-agent changes nothing. */
export function applyChatFrame(messages: ChatMessage[], frame: ChatFrame, assistantId: string): ApplyFrameResult {
    if (!isRootFrame(frame)) return { messages, terminal: null };
    if (frame.type === "finish") {
        return {
            messages: frame.turnUsage === undefined ? messages : stampUsage(messages, assistantId, frame.turnUsage),
            terminal: "finish",
        };
    }
    if (frame.type === "error") {
        return { messages, terminal: { error: frame } };
    }
    if (frame.type === "iteration" || frame.type === "message-start") return { messages, terminal: null };

    const partFrame = frame;
    const next = updateAssistant(messages, assistantId, (parts) => applyPartFrame(parts, partFrame));
    return { messages: next, terminal: null };
}

function applyPartFrame(parts: MessagePart[], frame: Exclude<ChatFrame, FinishEvent | ChatErrorEvent | IterationEvent | MessageStartEvent>): MessagePart[] {
    switch (frame.type) {
        case "text-delta":
            return mergeTextDelta(parts, frame.text);
        case "tool-started":
            return [
                ...parts,
                {
                    type: "tool-call",
                    toolCallId: frame.toolUseId,
                    toolName: frame.name,
                    detail: frame.detail,
                } satisfies ToolCallPart,
            ];
        case "tool-finished": {
            const finished: ToolCallPart = {
                type: "tool-call",
                toolCallId: frame.toolUseId,
                toolName: frame.name,
                outcome: frame.outcome,
            };
            if (frame.detail !== undefined) finished.detail = frame.detail;
            if (frame.durationMs !== undefined) finished.durationMs = frame.durationMs;
            const started = parts.some((p) => p.type === "tool-call" && p.toolCallId === frame.toolUseId);
            if (!started) {
                // The stored transcript keeps a call whose start never arrived, thus a live view keeps it too.
                return [...parts, finished];
            }
            return parts.map((p) => (p.type !== "tool-call" || p.toolCallId !== frame.toolUseId ? p : { ...p, ...finished }));
        }
        default: {
            // A chat event type that no case above takes is not a part frame, thus this annotation fails to compile.
            const partFrame: ChatPartFrame = frame;
            // The source routes the frame, and it is not a field of the part. A rest type does not distribute over the
            // union of the part frames, thus the rest names the part that remains.
            const { source: _source, ...part } = partFrame;
            return upsertPart(parts, part);
        }
    }
}

function mergeTextDelta(parts: MessagePart[], delta: string): MessagePart[] {
    const last = parts[parts.length - 1];
    if (last && last.type === "text") {
        const merged: TextPart = { type: "text", text: last.text + delta };
        return [...parts.slice(0, -1), merged];
    }
    return [...parts, { type: "text", text: delta } satisfies TextPart];
}

function stampUsage(messages: ChatMessage[], assistantId: string, usage: TokenUsageRollup): ChatMessage[] {
    const idx = messages.findIndex((m) => m.id === assistantId);
    const message = messages[idx];
    if (message === undefined) return messages;
    const next = messages.slice();
    next[idx] = { ...message, usage };
    return next;
}

function updateAssistant(messages: ChatMessage[], assistantId: string, updater: (parts: MessagePart[]) => MessagePart[]): ChatMessage[] {
    const idx = messages.findIndex((m) => m.id === assistantId);
    const existing = messages[idx];
    if (existing === undefined) return [...messages, { id: assistantId, role: "assistant", parts: updater([]) }];
    const next = messages.slice();
    next[idx] = { ...existing, parts: updater(existing.parts) };
    return next;
}
