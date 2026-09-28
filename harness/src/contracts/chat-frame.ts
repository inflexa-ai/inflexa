// The one translation path of a chat stream. Browser-safe: each import from outside `contracts/` is a type import.

import type { ChatDataPart, EmitEvent } from "../loop/types.js";
import type { ChatStreamEvent } from "../providers/types.js";
import type { ChatErrorEvent, ChatFrame, ChatPartFrame, EventSource } from "./chat-events.js";
import type { ChatPart } from "./chat-parts.js";
import type { ChatMessage, MessagePart, TextPart, ToolCallPart } from "./message.js";
import { isReconciling, PART_REGISTRY } from "./part-registry.js";
import type { TokenUsageRollup } from "./usage.js";

export type TurnTerminal = null | "finish" | { error: ChatErrorEvent };

export interface ApplyFrameResult {
    messages: ChatMessage[];
    terminal: TurnTerminal;
}

function toSource(source: EmitEvent["source"]): EventSource {
    return { agentId: source.agentId, callPath: [...source.callPath] };
}

/**
 * The frame of one emitted event, or `null` for `iteration` and `done`. A frame of a sub-agent keeps its source, thus a
 * consumer can filter it. A `text-delta` has no source, thus its frame gets `fallbackSource`, the source of the root agent.
 */
export function toChatFrame(event: EmitEvent | ChatStreamEvent | ChatDataPart, fallbackSource: EventSource): ChatFrame | null {
    switch (event.type) {
        case "iteration":
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
            return { type: "text-delta", text: event.text, source: fallbackSource };

        default: {
            // A `ChatDataPart`. The wire part is flat: `{ type, ...data }`.
            const data = (event.data ?? {}) as Record<string, unknown>;
            return { ...data, type: event.type, ...(event.source === undefined ? {} : { source: toSource(event.source) }) } as ChatPartFrame;
        }
    }
}

/**
 * Apply one frame to the messages of a live turn, with no change to the input. A frame whose `source.callPath` holds
 * more than one entry comes from a sub-agent and changes nothing, because the root agent of a chat turn has `[agent.id]`.
 */
export function applyChatFrame(messages: ChatMessage[], frame: ChatFrame, assistantId: string): ApplyFrameResult {
    if (frame.source !== undefined && frame.source.callPath.length > 1) return { messages, terminal: null };
    if (frame.type === "finish") {
        return {
            messages: frame.turnUsage === undefined ? messages : stampUsage(messages, assistantId, frame.turnUsage),
            terminal: "finish",
        };
    }
    if (frame.type === "error") {
        return { messages, terminal: { error: frame } };
    }

    const next = updateAssistant(messages, assistantId, (parts) => applyPartFrame(parts, frame));
    return { messages: next, terminal: null };
}

function applyPartFrame(parts: MessagePart[], frame: ChatFrame): MessagePart[] {
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
        case "tool-finished":
            return parts.map((p) =>
                p.type === "tool-call" && p.toolCallId === frame.toolUseId
                    ? ({
                          ...p,
                          outcome: frame.outcome,
                          ...(frame.detail === undefined ? {} : { detail: frame.detail }),
                          ...(frame.durationMs === undefined ? {} : { durationMs: frame.durationMs }),
                      } satisfies ToolCallPart)
                    : p,
            );
        default: {
            // Each remaining frame is a `data-*` part. Its source routes the frame, and it is not a field of the part.
            const { source: _source, ...part } = frame as ChatPartFrame;
            return upsertDataPart(parts, part as ChatPart);
        }
    }
}

/**
 * Append a data part, or replace the part that it reconciles with. The registry names the reconciling types, and the
 * latest part takes the position of the first one, the same rule that the replay merges rounds by.
 */
function upsertDataPart(parts: MessagePart[], part: ChatPart): MessagePart[] {
    const id = reconcileId(part);
    if (id === undefined) return [...parts, part];
    const index = parts.findIndex((p) => p.type === part.type && "id" in p && p.id === id);
    if (index === -1) return [...parts, part];
    const next = parts.slice();
    next[index] = part;
    return next;
}

function reconcileId(part: ChatPart): string | undefined {
    // A frame from a newer emitter can carry a type that this registry does not know. Such a part appends.
    if (!Object.hasOwn(PART_REGISTRY, part.type) || !isReconciling(part.type)) return undefined;
    return "id" in part && typeof part.id === "string" ? part.id : undefined;
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
    if (idx === -1) return messages;
    const next = messages.slice();
    next[idx] = { ...messages[idx]!, usage };
    return next;
}

function updateAssistant(messages: ChatMessage[], assistantId: string, updater: (parts: MessagePart[]) => MessagePart[]): ChatMessage[] {
    const idx = messages.findIndex((m) => m.id === assistantId);
    if (idx === -1) {
        const fresh: ChatMessage = {
            id: assistantId,
            role: "assistant",
            parts: updater([]),
        };
        return [...messages, fresh];
    }
    const existing = messages[idx]!;
    const updated: ChatMessage = { ...existing, parts: updater(existing.parts) };
    const next = messages.slice();
    next[idx] = updated;
    return next;
}
