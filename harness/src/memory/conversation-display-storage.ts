/**
 * The durable conversation display projection — what the user was shown,
 * persisted verbatim.
 *
 * AI SDK `UIMessage` is the CONTAINER: it supplies message identity, role,
 * ordering, metadata, and `validateUIMessages` for runtime validation. The PARTS
 * vocabulary is Cortex's own, because ours is the richer one — a `CortexPart`
 * carries a tool call's four-way outcome and its one-line detail, and AI SDK's
 * `dynamic-tool` part has nowhere to put either. Mapping through `dynamic-tool`
 * would silently drop both on every reload, so every non-text part rides as a
 * typed `DataUIPart` whose payload IS the Cortex part minus its discriminant.
 *
 * The projection is therefore lossless in both directions, and the read path
 * ({@link conversationUIToCortexMessages}) is a near-identity rather than a
 * reconstruction.
 */

import { validateUIMessages, type DataUIPart, type UIMessage, type UIMessagePart } from "ai";
import { z } from "zod";

import type { AskPart, FileReferencePart, PlanPart, PresentationPart, PreviewPart, DataPreviewFailedPart, RunCardPart } from "../contracts/chat-parts.js";
import {
    AskPartSchema,
    DataPreviewFailedPartSchema,
    FileReferencePartSchema,
    PlanPartSchema,
    PresentationPartSchema,
    PreviewPartSchema,
    RunCardPartSchema,
} from "../contracts/schemas/chat-parts.js";
import { ToolCallOutcomeSchema } from "../contracts/schemas/chat-events.js";
import type { ToolCallOutcome } from "../contracts/chat-events.js";
import type { CortexMessage, CortexPart, ToolCallPart } from "../contracts/message.js";

export const SUPPORTED_DISPLAY_SCHEMA_VERSION = 1;

type Payload<T extends { type: string }> = Omit<T, "type">;

/**
 * The AI SDK custom-data vocabulary persisted for one conversation display.
 *
 * Each key `k` becomes a `data-${k}` part whose payload is the matching Cortex
 * part without its `type` field, so a stored part and a wire part differ only in
 * where the discriminant lives.
 */
export type ConversationUIData = {
    "tool-call": Omit<Payload<ToolCallPart>, "outcome"> & { outcome: ToolCallOutcome };
    presentation: Payload<PresentationPart>;
    plan: Payload<PlanPart>;
    "run-card": Payload<RunCardPart>;
    "file-reference": Payload<FileReferencePart>;
    ask: Payload<AskPart>;
    "report-preview": Payload<PreviewPart>;
    "report-preview-failed": Payload<DataPreviewFailedPart>;
};

export interface ConversationDisplayMetadata {
    interrupted?: boolean;
}

export type ConversationUIMessage = UIMessage<ConversationDisplayMetadata, ConversationUIData>;

const DisplayEnvelopeHeaderSchema = z.object({
    kind: z.literal("ai-sdk-ui-messages"),
    aiSdkMajor: z.literal(7),
    schemaVersion: z.literal(SUPPORTED_DISPLAY_SCHEMA_VERSION),
    messages: z.array(z.unknown()).min(1),
});

/**
 * Declared here rather than derived from `contracts/schemas/chat-parts.ts`: a
 * tool call is not a chat DATA part on the wire — it reaches a host as the
 * `tool-started`/`tool-finished` event pair — so `chat-parts.ts` has no member to
 * omit a discriminant from. Storage is the only place the pair is flattened into
 * one part, and this is that shape.
 *
 * `outcome` is REQUIRED, and carries the whole terminal state including
 * `incomplete`. A record describes a call that is no longer running, so "still in
 * flight" is not a state it can be in — a turn cut off mid-call recorded a
 * dispatch with no completion, which is what `incomplete` says. Storing a
 * lifecycle field beside an optional outcome instead would put the meaning of the
 * combination in each reader's head, and readers would disagree.
 */
const ToolCallDisplaySchema = z
    .object({
        toolCallId: z.string(),
        toolName: z.string(),
        outcome: ToolCallOutcomeSchema,
        detail: z.string().optional(),
    })
    .strict();

const dataSchemas = {
    "tool-call": ToolCallDisplaySchema,
    presentation: PresentationPartSchema.omit({ type: true }).strict(),
    plan: PlanPartSchema.omit({ type: true }).strict(),
    "run-card": RunCardPartSchema.omit({ type: true }).strict(),
    "file-reference": FileReferencePartSchema.omit({ type: true }).strict(),
    ask: AskPartSchema.omit({ type: true }).strict(),
    "report-preview": PreviewPartSchema.omit({ type: true }).strict(),
    "report-preview-failed": DataPreviewFailedPartSchema.omit({ type: true }).strict(),
};

export interface StoredDisplayEnvelope {
    readonly kind: "ai-sdk-ui-messages";
    readonly aiSdkMajor: 7;
    readonly schemaVersion: typeof SUPPORTED_DISPLAY_SCHEMA_VERSION;
    readonly messages: ConversationUIMessage[];
}

export function envelopeDisplayMessages(messages: readonly ConversationUIMessage[]): StoredDisplayEnvelope {
    if (messages.length === 0) throw new Error("A conversation display envelope must contain at least one UI message");
    return {
        kind: "ai-sdk-ui-messages",
        aiSdkMajor: 7,
        schemaVersion: SUPPORTED_DISPLAY_SCHEMA_VERSION,
        messages: structuredClone(messages) as ConversationUIMessage[],
    };
}

export async function parseStoredDisplayEnvelope(value: unknown, identity: string): Promise<StoredDisplayEnvelope> {
    const header = DisplayEnvelopeHeaderSchema.safeParse(value);
    if (!header.success) {
        throw new Error(`Invalid stored conversation display envelope at ${identity}: ${header.error.message}`);
    }

    try {
        const messages = await validateUIMessages<ConversationUIMessage>({
            messages: header.data.messages,
            dataSchemas,
            metadataSchema: z.object({ interrupted: z.boolean().optional() }).optional(),
        });
        return { ...header.data, messages };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid stored conversation display envelope at ${identity}: ${message}`, { cause: error });
    }
}

/** The data-part key a Cortex part is stored under — its `type` minus the `data-` prefix. */
function displayPartType(part: Exclude<CortexPart, { type: "text" }>): `data-${keyof ConversationUIData & string}` {
    return (part.type === "tool-call" ? "data-tool-call" : part.type) as `data-${keyof ConversationUIData & string}`;
}

/** The id a part reconciles on: a tool call by its call id, a card by its own stable id. */
function displayPartId(part: Exclude<CortexPart, { type: "text" }>): string | undefined {
    if (part.type === "tool-call") return part.toolCallId;
    return "id" in part && typeof part.id === "string" ? part.id : undefined;
}

/**
 * Build the stored form of one non-text Cortex part.
 *
 * A tool call is the one part whose stored payload is not simply the Cortex part
 * minus its discriminant: `outcome` is optional on the live part (absent means in
 * flight) and required here, because a record is of a call that is no longer
 * running. An in-flight call being recorded is one the turn never saw finish, so
 * absence resolves to `incomplete` at exactly this boundary — once, where the
 * lifetime changes — rather than at each reader.
 */
export function conversationDisplayPart(part: Exclude<CortexPart, { type: "text" }>): DataUIPart<ConversationUIData> {
    const { type: _type, ...rest } = part;
    const data = part.type === "tool-call" ? { ...rest, outcome: part.outcome ?? "incomplete" } : rest;
    return { type: displayPartType(part), id: displayPartId(part), data } as DataUIPart<ConversationUIData>;
}

/**
 * Project Cortex display messages into the durable representation.
 *
 * The startup backfill's only path into storage: it renders a legacy turn from
 * the model transcript and freezes the result. The live recorder builds the same
 * shape directly from the event stream instead of round-tripping through
 * `CortexMessage`.
 */
export function cortexMessagesToConversationUI(messages: readonly CortexMessage[]): ConversationUIMessage[] {
    return messages.map((message) => {
        const parts: UIMessagePart<ConversationUIData, Record<string, never>>[] = message.parts.map((part) =>
            part.type === "text" ? { type: "text", text: part.text, state: "done" } : conversationDisplayPart(part),
        );
        return {
            id: message.id,
            role: message.role,
            ...(message.interrupted ? { metadata: { interrupted: true } } : {}),
            parts,
        };
    });
}

/**
 * Read the durable representation back as Cortex display messages.
 *
 * Every part round-trips by moving its discriminant back out of the part type,
 * so nothing here consults a tool name, a registry, or the filesystem. A message
 * whose parts all render empty is dropped so the transcript has no empty bubbles.
 */
export function conversationUIToCortexMessages(messages: readonly ConversationUIMessage[]): CortexMessage[] {
    const out: CortexMessage[] = [];
    for (const message of messages) {
        const parts: CortexPart[] = [];
        for (const part of message.parts) {
            if (part.type === "text") {
                if (part.text.length > 0) parts.push({ type: "text", text: part.text });
                continue;
            }
            if (part.type === "data-tool-call") {
                parts.push({ type: "tool-call", ...part.data });
                continue;
            }
            if (part.type.startsWith("data-")) {
                const data = part as DataUIPart<ConversationUIData>;
                parts.push({ type: data.type, ...(data.data as object) } as CortexPart);
            }
        }
        if (parts.length === 0) continue;
        out.push({
            id: message.id,
            role: message.role,
            parts,
            ...(message.metadata?.interrupted ? { interrupted: true } : {}),
        });
    }
    return out;
}
