import { randomUUID } from "node:crypto";
import type { DataUIPart, UIMessagePart } from "ai";

import type { ToolCallOutcome } from "../contracts/chat-events.js";
import { PART_REGISTRY, type CortexChatPartType } from "../contracts/part-registry.js";
import { CortexChatPartSchema } from "../contracts/schemas/chat-parts.js";
import type { ChatDataPart, EmitFn } from "../loop/types.js";
import { conversationDisplayPart, type ConversationUIData, type ConversationUIMessage } from "./conversation-display-storage.js";

export interface ConversationDisplayRecorder {
    readonly emit: EmitFn;
    finish(options?: { readonly fallbackText?: string; readonly interrupted?: boolean }): ConversationUIMessage[];
}

export interface ConversationDisplayRecorderOptions {
    readonly userText: string;
    readonly topLevelCallPath: readonly string[];
    readonly sink: EmitFn;
    readonly userMessageId?: string;
    readonly assistantMessageId?: string;
}

type ConversationPart = DataUIPart<ConversationUIData>;
type DisplayPart = UIMessagePart<ConversationUIData, Record<string, never>>;

function jsonCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function isSubAgent(event: Parameters<EmitFn>[0], topLevelCallPath: readonly string[]): boolean {
    if (!("source" in event) || event.source === undefined) return false;
    const path = event.source.callPath;
    return path.length > topLevelCallPath.length && topLevelCallPath.every((entry, index) => path[index] === entry);
}

function durableConversationType(type: string): type is CortexChatPartType {
    if (!Object.hasOwn(PART_REGISTRY, type)) return false;
    const descriptor = PART_REGISTRY[type as CortexChatPartType];
    return descriptor.emitter === "conversation" && descriptor.consumer === "conversation" && !descriptor.transient;
}

function dataPart(event: ChatDataPart): ConversationPart {
    const parsed = CortexChatPartSchema.safeParse({ type: event.type, ...(event.data as object) });
    if (!parsed.success) throw new Error(`Invalid emitted conversation part ${event.type}: ${parsed.error.message}`);
    const { type, ...data } = parsed.data;
    return {
        type,
        id: "id" in data && typeof data.id === "string" ? data.id : undefined,
        data: jsonCopy(data),
    } as ConversationPart;
}

export function createConversationDisplayRecorder(options: ConversationDisplayRecorderOptions): ConversationDisplayRecorder {
    const assistantParts: DisplayPart[] = [];
    // Where a reconciling part lives, keyed by `type:id`. Type-qualified because a
    // stable id is only unique within its own family — a plan and a run card may
    // legitimately share one.
    const reconcileIndexes = new Map<string, number>();
    let finished = false;

    /**
     * Place a part, replacing the one it reconciles with when it has a stable id.
     * A tool call reaching its `finished` state and an `ask` reaching its resolved
     * status are the same operation: latest-wins, in the position the part first
     * took, so a later part never jumps the ordering the user saw.
     */
    function upsert(part: ConversationPart, reconciling: boolean): void {
        if (!reconciling || part.id === undefined) {
            assistantParts.push(part);
            return;
        }
        const key = `${part.type}:${part.id}`;
        const index = reconcileIndexes.get(key);
        if (index !== undefined) {
            assistantParts[index] = part;
            return;
        }
        reconcileIndexes.set(key, assistantParts.length);
        assistantParts.push(part);
    }

    /**
     * Place or update a call's recorded state.
     *
     * A call is recorded `incomplete` the moment it is dispatched and overwritten with
     * its real outcome when it finishes. The record is therefore honest at every
     * instant, and a turn that ends mid-call needs no closing pass — the calls that
     * never finished are already saying so.
     */
    function recordToolCall(toolCallId: string, toolName: string, outcome: ToolCallOutcome, detail?: string): void {
        upsert(
            conversationDisplayPart({
                type: "tool-call",
                toolCallId,
                toolName,
                outcome,
                ...(detail === undefined ? {} : { detail }),
            }),
            true,
        );
    }

    function appendText(text: string): void {
        if (text.length === 0) return;
        const previous = assistantParts.at(-1);
        if (previous?.type === "text") {
            previous.text += text;
            return;
        }
        assistantParts.push({ type: "text", text, state: "streaming" });
    }

    function recordData(event: ChatDataPart): void {
        if (!durableConversationType(event.type)) return;
        upsert(dataPart(event), PART_REGISTRY[event.type as CortexChatPartType].reconciling);
    }

    const emit: EmitFn = (event) => {
        if (finished) return options.sink(event);
        if (!isSubAgent(event, options.topLevelCallPath)) {
            switch (event.type) {
                case "text-delta":
                    appendText(event.text);
                    break;
                // The detail the loop computed at dispatch is recorded as shown. It is
                // NOT re-derived on reload: doing that would need the tool's schema and
                // the raw input, which is the tool-name coupling the display projection
                // exists to remove.
                case "tool-started":
                    recordToolCall(event.toolUseId, event.name, "incomplete", event.detail);
                    break;
                case "tool-finished":
                    recordToolCall(event.toolUseId, event.name, event.outcome, event.detail);
                    break;
                case "done":
                case "iteration":
                    break;
                default:
                    recordData(event);
                    break;
            }
        }
        return options.sink(event);
    };

    function finish(finishOptions?: { readonly fallbackText?: string; readonly interrupted?: boolean }): ConversationUIMessage[] {
        if (!finished) {
            finished = true;
            if (!assistantParts.some((part) => part.type === "text") && finishOptions?.fallbackText) {
                appendText(finishOptions.fallbackText);
            }
            // Calls need no closing pass: one that never reached `tool-finished` still holds
            // the `incomplete` it was recorded with at dispatch, which is the whole of what
            // the harness observed. An approval does need one — `pending` is a question, and
            // a turn that ends without answering it aborted it.
            for (const part of assistantParts) {
                if (part.type === "data-ask" && part.data.status === "pending") {
                    part.data.status = "aborted";
                }
            }
            for (const part of assistantParts) {
                if (part.type === "text") part.state = "done";
            }
        }

        const messages: ConversationUIMessage[] = [
            {
                id: options.userMessageId ?? randomUUID(),
                role: "user",
                parts: [{ type: "text", text: options.userText, state: "done" }],
            },
        ];
        if (assistantParts.length > 0) {
            messages.push({
                id: options.assistantMessageId ?? randomUUID(),
                role: "assistant",
                ...(finishOptions?.interrupted ? { metadata: { interrupted: true } } : {}),
                parts: jsonCopy(assistantParts),
            });
        }
        return messages;
    }

    return { emit, finish };
}
