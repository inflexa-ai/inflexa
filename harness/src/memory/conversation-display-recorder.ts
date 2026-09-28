import { randomUUID } from "node:crypto";
import type { ModelMessage, UIMessagePart } from "ai";

import type { ChatFrame, ChatPartFrame, EventSource } from "../contracts/chat-events.js";
import { applyChatFrame, isRootFrame, toChatFrame } from "../contracts/chat-frame.js";
import type { ChatMessage, MessagePart } from "../contracts/message.js";
import { PART_REGISTRY, type ChatPartType } from "../contracts/part-registry.js";
import { ChatPartSchema } from "../contracts/schemas/chat-parts.js";
import type { EmitFn } from "../loop/types.js";
import { compactionExchangeOf, compactionMarkerOf, type CompactionMarker } from "./ai-sdk-message-storage.js";
import { conversationDisplayPart, type ConversationUIData, type ConversationUIMessage } from "./conversation-display-storage.js";

export interface ConversationDisplayRecorder {
    readonly emit: EmitFn;
    /** The user message of the turn. */
    takeOpening(): ConversationUIMessage[];
    /** The assistant message of one round, when the recorder got parts after the last take, and the divider of a marker of the round. */
    takeRound(messages: readonly ModelMessage[]): ConversationUIMessage[];
    /** The whole turn in one projection. `runChatTurn` stores each round with `takeOpening` and `takeRound` instead. */
    finish(options?: { readonly fallbackText?: string; readonly interrupted?: boolean }): ConversationUIMessage[];
}

export interface ConversationDisplayRecorderOptions {
    readonly userText: string;
    /** The root agent of the turn. Its call path is `[agentId]`, and an event with a longer path is from a sub-agent. */
    readonly agentId: string;
    readonly sink: EmitFn;
    readonly userMessageId?: string;
    readonly assistantMessageId?: string;
}

type DisplayPart = UIMessagePart<ConversationUIData, Record<string, never>>;

function jsonCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function durableConversationType(type: string): type is ChatPartType {
    if (!Object.hasOwn(PART_REGISTRY, type)) return false;
    const descriptor = PART_REGISTRY[type as ChatPartType];
    return descriptor.emitter === "conversation" && descriptor.consumer === "conversation" && !descriptor.transient;
}

/** The validated part of a data frame, copied at receipt, because the emitter keeps its own reference to the payload. */
function recordedPart(frame: ChatPartFrame): ChatPartFrame {
    const { source: _source, ...part } = frame;
    const parsed = ChatPartSchema.safeParse(part);
    if (!parsed.success) throw new Error(`Invalid emitted conversation part ${frame.type}: ${parsed.error.message}`);
    return jsonCopy(parsed.data);
}

/**
 * The stored form of the parts of one round. A round that closes ends each question that it asked, thus a
 * pending ask is stored `aborted`, and a call with no outcome is stored `incomplete` ({@link conversationDisplayPart}).
 */
function displayParts(parts: readonly MessagePart[]): DisplayPart[] {
    return parts.flatMap((part): DisplayPart[] => {
        if (part.type === "text") return part.text.length === 0 ? [] : [{ type: "text", text: part.text, state: "done" }];
        if (part.type === "data-ask" && part.status === "pending") return [conversationDisplayPart({ ...part, status: "aborted" })];
        return [conversationDisplayPart(part)];
    });
}

/** The text of the assistant messages of a round. The text of an exchange is a summary, and no reply. */
function assistantText(messages: readonly ModelMessage[]): string {
    return messages
        .filter((message) => message.role === "assistant" && compactionExchangeOf(message) === undefined)
        .map((message) =>
            typeof message.content === "string"
                ? message.content
                : message.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join(""),
        )
        .join("");
}

/** The divider of a compaction marker: a `system` message with the part at the final status of the compaction. */
function compactionDivider(marker: CompactionMarker): ConversationUIMessage {
    const part = conversationDisplayPart({
        type: "data-compaction",
        id: marker.id,
        status: marker.kind === "summary" ? "done" : "failed",
        tokensBefore: marker.tokensBefore,
        durationMs: marker.durationMs,
        ...(marker.trigger === undefined ? {} : { trigger: marker.trigger }),
    });
    return { id: marker.id, role: "system", parts: [part] };
}

/**
 * Record the display of a turn through the same translation path as a live surface: each event becomes a
 * frame (`toChatFrame`), and the frames build the messages of the round (`applyChatFrame`). Only a part that
 * the conversation keeps enters the record.
 */
export function createConversationDisplayRecorder(options: ConversationDisplayRecorderOptions): ConversationDisplayRecorder {
    // One id for each message of the turn, thus the rounds of a turn replay as one assistant message.
    const userMessageId = options.userMessageId ?? randomUUID();
    let assistantMessageId = options.assistantMessageId ?? randomUUID();
    const rootSource: EventSource = { agentId: options.agentId, callPath: [options.agentId] };
    // The messages of the open round. A later update of a part lands in the next round, and the replay replaces the earlier copy.
    let round: ChatMessage[] = [];
    let finished = false;

    function apply(frame: ChatFrame): void {
        round = applyChatFrame(round, frame, assistantMessageId).messages;
    }

    function roundParts(): readonly MessagePart[] {
        return round.find((message) => message.id === assistantMessageId)?.parts ?? [];
    }

    function hasText(): boolean {
        return roundParts().some((part) => part.type === "text" && part.text.length > 0);
    }

    function appendText(text: string): void {
        if (text.length > 0) apply({ type: "text-delta", text, source: rootSource });
    }

    function record(event: Parameters<EmitFn>[0]): void {
        const frame = toChatFrame(event, rootSource);
        if (frame === null || !isRootFrame(frame)) return;
        if (frame.type.startsWith("data-")) {
            // Each chat event type is named without the `data-` prefix, thus a `data-` frame is a part frame.
            if (durableConversationType(frame.type)) apply(recordedPart(frame as ChatPartFrame));
            return;
        }
        apply(frame);
    }

    const emit: EmitFn = (event) => {
        if (!finished) record(event);
        return options.sink(event);
    };

    function takeOpening(): ConversationUIMessage[] {
        return [{ id: userMessageId, role: "user", parts: [{ type: "text", text: options.userText, state: "done" }] }];
    }

    function takeRound(messages: readonly ModelMessage[]): ConversationUIMessage[] {
        if (!hasText()) appendText(assistantText(messages));
        const parts = displayParts(roundParts());
        const taken: ConversationUIMessage[] = parts.length === 0 ? [] : [{ id: assistantMessageId, role: "assistant", parts: jsonCopy(parts) }];
        round = [];
        const marker = messages.map(compactionMarkerOf).find((found) => found !== undefined);
        if (marker !== undefined) {
            taken.push(compactionDivider(marker));
            // The divider splits the turn into two assistant messages of the replay, and two messages must not share an id.
            assistantMessageId = randomUUID();
        }
        return taken;
    }

    function finish(finishOptions?: { readonly fallbackText?: string; readonly interrupted?: boolean }): ConversationUIMessage[] {
        if (!finished) {
            finished = true;
            if (!hasText() && finishOptions?.fallbackText) appendText(finishOptions.fallbackText);
        }

        const messages = takeOpening();
        const parts = displayParts(roundParts());
        if (parts.length > 0) {
            messages.push({
                id: assistantMessageId,
                role: "assistant",
                ...(finishOptions?.interrupted ? { metadata: { interrupted: true } } : {}),
                parts: jsonCopy(parts),
            });
        }
        return messages;
    }

    return { emit, takeOpening, takeRound, finish };
}
