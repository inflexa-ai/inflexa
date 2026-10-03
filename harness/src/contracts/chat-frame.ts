// The one translation path of a chat stream. Browser-safe: each import from outside `contracts/` is a type import.

import type { ChatDataPart, EmitEvent } from "../loop/types.js";
import type { ChatStreamEvent } from "../providers/types.js";
import type { ChatErrorEvent, ChatFrame, ChatPartFrame, EventSource, FinishEvent, IterationEvent } from "./chat-events.js";
import type { ChatPart } from "./chat-parts.js";
import type { ChatMessage, MessagePart, TextPart, ToolCallPart } from "./message.js";
import { isReconciling, PART_REGISTRY } from "./part-registry.js";
import { EventSourceSchema } from "./schemas/chat-events.js";
import { ChatPartSchema } from "./schemas/chat-parts.js";
import type { TokenUsageRollup } from "./usage.js";

export type TurnTerminal = null | "finish" | { error: ChatErrorEvent };

export interface ApplyFrameResult {
    messages: ChatMessage[];
    terminal: TurnTerminal;
}

export type ChatPartCheck = { readonly ok: true; readonly frame: ChatPartFrame } | { readonly ok: false; readonly error: string };

function toSource(source: EmitEvent["source"]): EventSource {
    return { agentId: source.agentId, callPath: [...source.callPath] };
}

/**
 * The frame of one emitted event, or `null` for `done` and for an `iteration` of the root agent. A frame of a sub-agent
 * keeps its source, thus a consumer can filter it. A `text-delta` has no source, thus its frame gets `fallbackSource`,
 * the source of the root agent. A part frame is not checked here: {@link checkChatPart} checks it where it arrives.
 */
export function toChatFrame(event: EmitEvent | ChatStreamEvent | ChatDataPart, fallbackSource: EmitEvent["source"]): ChatFrame | null {
    switch (event.type) {
        case "iteration":
            // The root loop gives none: a consumer of the root frames, for example the first-frame time of a
            // browser, must not read the start of a model request as output.
            return event.source.callPath.length > 1 ? { type: "iteration", source: toSource(event.source) } : null;

        case "done":
            return null;

        case "tool-started":
            return {
                type: "tool-started",
                toolUseId: event.toolUseId,
                name: event.name,
                ...(event.detail === undefined ? {} : { detail: event.detail }),
                source: toSource(event.source),
            };

        case "tool-finished":
            return {
                type: "tool-finished",
                toolUseId: event.toolUseId,
                name: event.name,
                outcome: event.outcome,
                ...(event.detail === undefined ? {} : { detail: event.detail }),
                ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
                source: toSource(event.source),
            };

        case "text-delta":
            return { type: "text-delta", text: event.text, source: toSource(fallbackSource) };

        default: {
            // A `ChatDataPart`, whose payload the emitter types as `unknown`. The wire part is flat: `{ type, ...data }`.
            // The cast names the frame that the type claims. `checkChatPart` is the check.
            const data = (event.data ?? {}) as Record<string, unknown>;
            return { ...data, type: event.type, ...(event.source === undefined ? {} : { source: toSource(event.source) }) } as ChatPartFrame;
        }
    }
}

/**
 * Check a part frame against the schema of its type, one time, where it arrives. The schema drops a field that it
 * does not know. A type that the registry does not know passes unchanged, because a newer emitter can send it. The
 * source is checked for each type, because {@link isRootFrame} reads its call path.
 */
export function checkChatPart(frame: ChatPartFrame): ChatPartCheck {
    const { source, ...part } = frame;
    if (source !== undefined) {
        const checkedSource = EventSourceSchema.safeParse(source);
        if (!checkedSource.success) return { ok: false, error: checkedSource.error.message };
    }
    if (!Object.hasOwn(PART_REGISTRY, frame.type)) return { ok: true, frame };
    const parsed = ChatPartSchema.safeParse(part);
    if (!parsed.success) return { ok: false, error: parsed.error.message };
    return { ok: true, frame: source === undefined ? parsed.data : { ...parsed.data, source } };
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
    if (part.type === "text" || !Object.hasOwn(PART_REGISTRY, part.type) || !isReconciling(part.type)) return undefined;
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
    if (frame.type === "iteration") return { messages, terminal: null };

    const partFrame = frame;
    const next = updateAssistant(messages, assistantId, (parts) => applyPartFrame(parts, partFrame));
    return { messages: next, terminal: null };
}

function applyPartFrame(parts: MessagePart[], frame: Exclude<ChatFrame, FinishEvent | ChatErrorEvent | IterationEvent>): MessagePart[] {
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
                    ...(frame.detail === undefined ? {} : { detail: frame.detail }),
                } satisfies ToolCallPart,
            ];
        case "tool-finished": {
            const finished = {
                type: "tool-call",
                toolCallId: frame.toolUseId,
                toolName: frame.name,
                outcome: frame.outcome,
                ...(frame.detail === undefined ? {} : { detail: frame.detail }),
                ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs }),
            } satisfies ToolCallPart;
            let started = false;
            const next = parts.map((p) => {
                if (p.type !== "tool-call" || p.toolCallId !== frame.toolUseId) return p;
                started = true;
                return { ...p, ...finished };
            });
            // The stored transcript keeps a call whose start never arrived, thus a live view keeps it too.
            return started ? next : [...parts, finished];
        }
        default: {
            // The source routes the frame, and it is not a field of the part. A rest type does not distribute over the
            // union of the part frames, thus the cast names the part that remains.
            const { source: _source, ...part } = frame;
            return upsertPart(parts, part as ChatPart);
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
