import { randomUUID } from "node:crypto";
import type { ModelMessage, UIMessagePart } from "ai";

import type { ChatFrame, ChatPartFrame, EventSource } from "../contracts/chat-events.js";
import { applyChatFrame, checkChatPart, isRootFrame, toChatFrame } from "../contracts/chat-frame.js";
import type { CompactionPart } from "../contracts/chat-parts.js";
import type { ChatMessage, MessagePart } from "../contracts/message.js";
import { PART_REGISTRY, type ChatPartType } from "../contracts/part-registry.js";
import { createSubAgentActivityTracker } from "../contracts/subagent-activity.js";
import type { EmitEvent, EmitFn } from "../loop/types.js";
import { compactionExchangeOf, compactionMarkerOf, type CompactionMarker } from "./ai-sdk-message-storage.js";
import { conversationDisplayPart, isStoredSourcePart, type ConversationUIData, type ConversationUIMessage } from "./conversation-display-storage.js";

export type ConversationDisplayRecorder = {
    readonly emit: EmitFn;
    /** The user message of the turn. */
    takeOpening(): ConversationUIMessage[];
    /** The assistant message of one round, when the recorder got parts after the last take, and the divider of a marker of the round. */
    takeRound(messages: readonly ModelMessage[]): ConversationUIMessage[];
    /** The whole turn in one projection. `runChatTurn` stores each round with `takeOpening` and `takeRound` instead. */
    finish(options?: { readonly fallbackText?: string; readonly interrupted?: boolean }): ConversationUIMessage[];
};

export type ConversationDisplayRecorderOptions = {
    readonly userText: string;
    /** The root agent of the turn. Its call path is `[agentId]`, and an event with a longer path is from a sub-agent. */
    readonly agentId: string;
    readonly sink: EmitFn;
    /** The clock for the times of the sub-agent activity, in milliseconds. The default is the wall clock. */
    readonly now?: () => number;
};

type DisplayPart = UIMessagePart<ConversationUIData, Record<string, never>>;

function jsonCopy<T>(value: T): T {
    return structuredClone(value);
}

const DURABLE_CONVERSATION_PART_TYPES: ReadonlySet<string> = new Set(
    Object.entries(PART_REGISTRY)
        .filter(([, descriptor]) => descriptor.emitter === "conversation" && descriptor.consumer === "conversation" && !descriptor.transient)
        .map(([type]) => type),
);

function durableConversationType(type: string): type is ChatPartType {
    return DURABLE_CONVERSATION_PART_TYPES.has(type);
}

/** Each chat event type is named without the `data-` prefix, thus a `data-` frame is a part frame. */
function isPartFrame(frame: ChatFrame): frame is ChatPartFrame {
    return frame.type.startsWith("data-");
}

/** The checked part of a data frame, copied at receipt, because the emitter keeps its own reference to the payload. */
function recordedPart(frame: ChatPartFrame): ChatPartFrame {
    const checked = checkChatPart(frame);
    if (!checked.ok) throw new Error(`Invalid emitted conversation part ${frame.type}: ${checked.error}`);
    return jsonCopy(checked.frame);
}

/**
 * The stored form of the parts of one round. A round that closes ends each question that it asked, thus a
 * pending ask is stored `aborted`, and a call with no outcome is stored `incomplete` ({@link conversationDisplayPart}).
 */
function displayParts(parts: readonly MessagePart[]): DisplayPart[] {
    return parts.flatMap((part): DisplayPart[] => {
        if (part.type === "text") return part.text.length === 0 ? [] : [{ type: "text", text: part.text, state: "done" }];
        if (!isStoredSourcePart(part)) return [];
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
    const compaction: CompactionPart = {
        type: "data-compaction",
        id: marker.id,
        status: marker.kind === "summary" ? "done" : "failed",
        tokensBefore: marker.tokensBefore,
        durationMs: marker.durationMs,
    };
    if (marker.trigger !== undefined) compaction.trigger = marker.trigger;
    const part = conversationDisplayPart(compaction);
    return { id: marker.id, role: "system", parts: [part] };
}

/**
 * Record the display of a turn through the same translation path as a live surface: each event becomes a
 * frame (`toChatFrame`), and the frames build the messages of the round (`applyChatFrame`). Only a part that
 * the conversation keeps enters the record.
 */
export function createConversationDisplayRecorder(options: ConversationDisplayRecorderOptions): ConversationDisplayRecorder {
    // One id for each message of the turn, thus the rounds of a turn replay as one assistant message.
    const userMessageId = randomUUID();
    let assistantMessageId = randomUUID();
    let userAnnounced = false;
    let announcedAssistantId: string | undefined;
    const rootSource: EventSource = { agentId: options.agentId, callPath: [options.agentId] };
    // The messages of the open round. A later update of a part lands in the next round, and the replay replaces the earlier copy.
    let round: ChatMessage[] = [];
    let finished = false;
    const now = options.now ?? Date.now;
    const subAgentActivity = createSubAgentActivityTracker();

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
        if (frame === null) return;
        // The tracker reads the frames of the sub-agents, and `applyChatFrame` ignores them.
        const activity = subAgentActivity.track(frame, now());
        if (activity !== null && durableConversationType(activity.type)) apply(recordedPart(activity));
        if (!isRootFrame(frame)) return;
        if (isPartFrame(frame)) {
            if (durableConversationType(frame.type)) apply(recordedPart(frame));
            return;
        }
        apply(frame);
    }

    function messageStart(messageId: string, role: "user" | "assistant"): EmitEvent {
        return { type: "message-start", messageId, role, source: rootSource };
    }

    /** The `message-start` of each id that the sink did not get yet. */
    function announcements(): EmitEvent[] {
        const starts: EmitEvent[] = [];
        if (!userAnnounced) {
            userAnnounced = true;
            starts.push(messageStart(userMessageId, "user"));
        }
        if (announcedAssistantId !== assistantMessageId) {
            announcedAssistantId = assistantMessageId;
            starts.push(messageStart(assistantMessageId, "assistant"));
        }
        return starts;
    }

    // A `message-start` goes to the sink only immediately before an event: a host reads the first call of its sink
    // as the start of the turn, and a turn that ends before any event must still get its plain refusal (for example an HTTP 402).
    const emit: EmitFn = (event) => {
        if (!finished) record(event);
        const starts = announcements();
        if (starts.length === 0) return options.sink(event);
        // The calls start in the order of the stream with no await between them: a later emit that its caller does
        // not await, for example a text delta, must not reach the sink before them.
        return Promise.all([...starts, event].map((next) => options.sink(next))).then(() => undefined);
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
            const message: ConversationUIMessage = {
                id: assistantMessageId,
                role: "assistant",
                parts: jsonCopy(parts),
            };
            if (finishOptions?.interrupted) message.metadata = { interrupted: true };
            messages.push(message);
        }
        return messages;
    }

    return { emit, takeOpening, takeRound, finish };
}
