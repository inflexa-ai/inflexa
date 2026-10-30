/**
 * The durable conversation display projection — what the user was shown,
 * persisted verbatim.
 *
 * AI SDK `UIMessage` is the CONTAINER: it supplies message identity, role,
 * ordering, metadata, and `validateUIMessages` for runtime validation. The PARTS
 * vocabulary is the harness's own, because ours is the richer one — a `MessagePart`
 * carries a tool call's four-way outcome and its one-line detail, and AI SDK's
 * `dynamic-tool` part has nowhere to put either. Mapping through `dynamic-tool`
 * would silently drop both on every reload, so every non-text part rides as a
 * typed `DataUIPart` whose payload IS the message part minus its discriminant.
 *
 * The projection is therefore lossless in both directions, and the read path
 * ({@link conversationUIToChatMessages}) is a near-identity rather than a
 * reconstruction.
 */

import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";
import { isDataUIPart, validateUIMessages, type DataUIPart, type UIMessage } from "ai";
import { z } from "zod";

import { parseUnknownRecord } from "../lib/unknown-containers.js";

import type {
    AskPart,
    ChildSessionStartedPart,
    CompactionPart,
    FileReferencePart,
    PlanApprovalPart,
    PlanPart,
    PresentationPart,
    ReportRenderedPart,
    RunCardPart,
    SubAgentActivityEntry,
    SubAgentActivityPart,
} from "../contracts/chat-parts.js";
import {
    AskPartSchema,
    ChildSessionStartedPartSchema,
    CompactionPartSchema,
    FileReferencePartSchema,
    PlanApprovalPartSchema,
    PlanPartSchema,
    PresentationPartSchema,
    ReportRenderedPartSchema,
    RunCardPartSchema,
    SubAgentActivityEntrySchema,
    SubAgentActivityPartSchema,
} from "../contracts/schemas/chat-parts.js";
import { ToolCallOutcomeSchema, ToolCallValueSchema } from "../contracts/schemas/chat-events.js";
import type { ToolCallOutcome } from "../contracts/chat-events.js";
import type { ChatMessage, MessagePart, ToolCallPart } from "../contracts/message.js";
import type { Logger } from "../lib/logger.js";

export const SUPPORTED_DISPLAY_SCHEMA_VERSION = 1;

type Payload<T extends { type: string }> = Omit<T, "type">;

/**
 * The AI SDK custom-data vocabulary persisted for one conversation display.
 *
 * Each key `k` becomes a `data-${k}` part whose payload is the matching message
 * part without its `type` field, so a stored part and a wire part differ only in
 * where the discriminant lives.
 */
export type ConversationUIData = {
    "tool-call": Omit<Payload<ToolCallPart>, "outcome"> & { outcome: ToolCallOutcome };
    presentation: Payload<PresentationPart>;
    plan: Payload<PlanPart>;
    "run-card": Payload<RunCardPart>;
    "plan-approval": Payload<PlanApprovalPart>;
    "file-reference": Payload<FileReferencePart>;
    ask: Payload<AskPart>;
    "child-session-started": Payload<ChildSessionStartedPart>;
    "report-rendered": Payload<ReportRenderedPart>;
    compaction: Payload<CompactionPart>;
    "subagent-activity": Omit<Payload<SubAgentActivityPart>, "entries"> & {
        entries: (Omit<SubAgentActivityEntry, "outcome"> & { outcome: ToolCallOutcome })[];
    };
};

export type ConversationDisplayMetadata = {
    interrupted?: boolean;
};

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
const ToolCallDisplaySchema = z.object({
    toolCallId: z.string(),
    toolName: z.string(),
    outcome: ToolCallOutcomeSchema,
    detail: z.string().optional(),
    durationMs: z.number().optional(),
    input: ToolCallValueSchema.optional(),
    result: ToolCallValueSchema.optional(),
    error: ToolCallValueSchema.optional(),
});

/**
 * The schema behind each stored part key.
 *
 * Deliberately NOT `.strict()`. These validate rows this package wrote itself,
 * months earlier, in another process — so the only thing an unknown key can mean
 * is that the part shed a field since. Rejecting the row for it would make
 * dropping an optional field, otherwise the safest change available, a
 * read-breaking one. Zod strips the stale key instead, which is what a reader
 * would do with it anyway.
 *
 * A key stays here as long as rows written under it must still render: the
 * vocabulary is append-mostly, and retiring an entry is what
 * {@link parseStoredDisplayEnvelope}'s filter then has to paper over.
 */
const dataSchemas = {
    "tool-call": ToolCallDisplaySchema,
    presentation: PresentationPartSchema.omit({ type: true }),
    plan: PlanPartSchema.omit({ type: true }),
    "run-card": RunCardPartSchema.omit({ type: true }),
    "plan-approval": PlanApprovalPartSchema.omit({ type: true }),
    "file-reference": FileReferencePartSchema.omit({ type: true }),
    ask: AskPartSchema.omit({ type: true }),
    "child-session-started": ChildSessionStartedPartSchema.omit({ type: true }),
    "report-rendered": ReportRenderedPartSchema.omit({ type: true }),
    compaction: CompactionPartSchema.omit({ type: true }),
    "subagent-activity": SubAgentActivityPartSchema.omit({ type: true }).extend({
        entries: z.array(SubAgentActivityEntrySchema.extend({ outcome: ToolCallOutcomeSchema })),
    }),
};

export type StoredDisplayEnvelope = {
    readonly kind: "ai-sdk-ui-messages";
    readonly aiSdkMajor: 7;
    readonly schemaVersion: typeof SUPPORTED_DISPLAY_SCHEMA_VERSION;
    readonly messages: ConversationUIMessage[];
};

export function envelopeDisplayMessages(messages: readonly ConversationUIMessage[]): StoredDisplayEnvelope {
    if (messages.length === 0) throw new Error("A conversation display envelope must contain at least one UI message");
    return {
        kind: "ai-sdk-ui-messages",
        aiSdkMajor: 7,
        schemaVersion: SUPPORTED_DISPLAY_SCHEMA_VERSION,
        messages: structuredClone([...messages]),
    };
}

/**
 * Strip every `data-*` part the current vocabulary cannot render.
 *
 * `validateUIMessages` rejects a whole envelope when one part's key is absent
 * from `dataSchemas`, and exposes no lenient mode, so the filter has to run
 * ahead of it. Two things go: a part whose key was retired, and a part whose
 * payload no longer satisfies the schema still standing behind its key — the
 * second reachable only by making a field required after rows were written,
 * since the schemas strip rather than reject what they don't know.
 *
 * Both are schema evolution, and a transcript missing one card reads better than
 * a thread that will not load at all. That is the whole line: a part this
 * package can identify but no longer understands is dropped; anything it cannot
 * identify AS a part — a non-array `messages`, a part with no `type` — is
 * corruption, passes through untouched, and still fails the validator. There is
 * no partial recovery available for a shape you cannot walk.
 */
function dropUnrenderableDataParts(messages: readonly unknown[], identity: string, logger?: Logger): unknown[] {
    const unknownKey: string[] = [];
    const schemaMismatch: string[] = [];

    const filtered = messages.map((message) => {
        const record = parseUnknownRecord(message);
        if (record === undefined || !Array.isArray(record.parts)) return message;
        const parts = record.parts.filter((part: unknown) => {
            const partRecord = parseUnknownRecord(part);
            if (partRecord === undefined || typeof partRecord.type !== "string" || !partRecord.type.startsWith("data-")) return true;
            const key = partRecord.type.slice("data-".length);
            // `Object.hasOwn` before the index: a part typed `data-constructor`
            // would otherwise resolve up the prototype chain to something that is
            // not a schema at all, and throw where it should have been dropped.
            // `Object.entries` lists own keys only, so the lookup refuses a
            // prototype name the same way.
            const schema = dataSchemaOf(key);
            if (schema === undefined) {
                unknownKey.push(partRecord.type);
                return false;
            }
            if (!schema.safeParse(partRecord.data).success) {
                schemaMismatch.push(partRecord.type);
                return false;
            }
            return true;
        });
        return parts.length === record.parts.length ? message : { ...record, parts };
    });

    if (unknownKey.length > 0 || schemaMismatch.length > 0) {
        const fields: Record<string, unknown> = { identity };
        if (unknownKey.length > 0) fields.unknownKey = [...new Set(unknownKey)];
        if (schemaMismatch.length > 0) fields.schemaMismatch = [...new Set(schemaMismatch)];
        logger?.warn("dropped unrenderable stored display parts", fields);
    }
    return filtered;
}

/** The schema behind one stored data-part key, or `undefined` when the key was retired or never stood. */
function dataSchemaOf(key: string): z.ZodType | undefined {
    const entry = Object.entries(dataSchemas).find(([name]) => name === key);
    return entry?.[1];
}

export async function parseStoredDisplayEnvelope(value: unknown, identity: string, logger?: Logger): Promise<StoredDisplayEnvelope> {
    const header = DisplayEnvelopeHeaderSchema.safeParse(value);
    if (!header.success) {
        throw new Error(`Invalid stored conversation display envelope at ${identity}: ${header.error.message}`);
    }

    try {
        const messages = await validateUIMessages<ConversationUIMessage>({
            messages: dropUnrenderableDataParts(header.data.messages, identity, logger),
            dataSchemas,
            metadataSchema: z.object({ interrupted: z.boolean().optional() }).optional(),
        });
        return { ...header.data, messages };
    } catch (error) {
        const message = errorMessageOf(error) ?? textOf(error);
        throw new Error(`Invalid stored conversation display envelope at ${identity}: ${message}`, { cause: error });
    }
}

/** The message-part arm a stored data part round-trips from: the payload is the arm minus its discriminant. */
export type StoredSourcePart = Extract<
    Exclude<MessagePart, { type: "text" }>,
    {
        type:
            | ToolCallPart["type"]
            | PresentationPart["type"]
            | PlanPart["type"]
            | RunCardPart["type"]
            | PlanApprovalPart["type"]
            | FileReferencePart["type"]
            | AskPart["type"]
            | ChildSessionStartedPart["type"]
            | ReportRenderedPart["type"]
            | CompactionPart["type"]
            | SubAgentActivityPart["type"];
    }
>;

const STORED_SOURCE_TYPES = [
    "tool-call",
    "data-presentation",
    "data-plan",
    "data-run-card",
    "data-plan-approval",
    "data-file-reference",
    "data-ask",
    "data-child-session-started",
    "data-report-rendered",
    "data-compaction",
    "data-subagent-activity",
] as const;
type _AssertStoredSourceTypesComplete = Exclude<StoredSourcePart["type"], (typeof STORED_SOURCE_TYPES)[number]> extends never ? true : never;

const STORED_SOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(STORED_SOURCE_TYPES);

/** Whether `part` is an arm the stored vocabulary can hold; anything else cannot become a stored card. */
export function isStoredSourcePart(part: Exclude<MessagePart, { type: "text" }>): part is StoredSourcePart {
    return STORED_SOURCE_TYPE_SET.has(part.type);
}

function closedEntry(entry: SubAgentActivityEntry): ConversationUIData["subagent-activity"]["entries"][number] {
    if (entry.outcome !== undefined) return { ...entry, outcome: entry.outcome };
    const { endedAt: _endedAt, ...open } = entry;
    return { ...open, outcome: "incomplete" };
}

/** The id a part reconciles on: a tool call by its call id, a card by its own stable id. */
function displayPartId(part: Exclude<MessagePart, { type: "text" }>): string | undefined {
    if (part.type === "tool-call") return part.toolCallId;
    return "id" in part && typeof part.id === "string" ? part.id : undefined;
}

/**
 * Build the stored form of one non-text message part.
 *
 * A tool call is the one part whose stored payload is not simply the message part
 * minus its discriminant: `outcome` is optional on the live part (absent means in
 * flight) and required here, because a record is of a call that is no longer
 * running. An in-flight call being recorded is one the turn never saw finish, so
 * absence resolves to `incomplete` at exactly this boundary — once, where the
 * lifetime changes — rather than at each reader. An entry of a sub-agent call
 * closes the same way, and an `incomplete` entry has no end time.
 */
export function conversationDisplayPart(part: StoredSourcePart): DataUIPart<ConversationUIData> {
    const id = displayPartId(part);
    switch (part.type) {
        case "tool-call": {
            const { type: _type, ...payload } = part;
            return { type: "data-tool-call", id, data: { ...payload, outcome: part.outcome ?? "incomplete" } };
        }
        case "data-presentation": {
            const { type: _type, ...data } = part;
            return { type: "data-presentation", id, data };
        }
        case "data-plan": {
            const { type: _type, ...data } = part;
            return { type: "data-plan", id, data };
        }
        case "data-run-card": {
            const { type: _type, ...data } = part;
            return { type: "data-run-card", id, data };
        }
        case "data-plan-approval": {
            const { type: _type, ...data } = part;
            return { type: "data-plan-approval", id, data };
        }
        case "data-file-reference": {
            const { type: _type, ...data } = part;
            return { type: "data-file-reference", id, data };
        }
        case "data-ask": {
            const { type: _type, ...data } = part;
            return { type: "data-ask", id, data };
        }
        case "data-child-session-started": {
            const { type: _type, ...data } = part;
            return { type: "data-child-session-started", id, data };
        }
        case "data-report-rendered": {
            const { type: _type, ...data } = part;
            return { type: "data-report-rendered", id, data };
        }
        case "data-compaction": {
            const { type: _type, ...data } = part;
            return { type: "data-compaction", id, data };
        }
        case "data-subagent-activity": {
            const { type: _type, ...payload } = part;
            return { type: "data-subagent-activity", id, data: { ...payload, entries: part.entries.map(closedEntry) } };
        }
        default: {
            const unreachable: never = part;
            return unreachable;
        }
    }
}

/**
 * Read the durable representation back as chat messages.
 *
 * Every part round-trips by moving its discriminant back out of the part type,
 * so nothing here consults a tool name, a registry, or the filesystem. A message
 * whose parts all render empty is dropped so the transcript has no empty bubbles.
 */
export function conversationUIToChatMessages(messages: readonly ConversationUIMessage[]): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const message of messages) {
        const parts: MessagePart[] = [];
        for (const part of message.parts) {
            if (part.type === "text") {
                if (part.text.length > 0) parts.push({ type: "text", text: part.text });
                continue;
            }
            if (part.type === "data-tool-call") {
                parts.push({ type: "tool-call", ...part.data });
                continue;
            }
            if (isDataUIPart<ConversationUIData>(part)) {
                switch (part.type) {
                    case "data-presentation":
                        parts.push({ type: "data-presentation", ...part.data });
                        break;
                    case "data-plan":
                        parts.push({ type: "data-plan", ...part.data });
                        break;
                    case "data-run-card":
                        parts.push({ type: "data-run-card", ...part.data });
                        break;
                    case "data-plan-approval":
                        parts.push({ type: "data-plan-approval", ...part.data });
                        break;
                    case "data-file-reference":
                        parts.push({ type: "data-file-reference", ...part.data });
                        break;
                    case "data-ask":
                        parts.push({ type: "data-ask", ...part.data });
                        break;
                    case "data-child-session-started":
                        parts.push({ type: "data-child-session-started", ...part.data });
                        break;
                    case "data-report-rendered":
                        parts.push({ type: "data-report-rendered", ...part.data });
                        break;
                    case "data-compaction":
                        parts.push({ type: "data-compaction", ...part.data });
                        break;
                    case "data-subagent-activity":
                        parts.push({ type: "data-subagent-activity", ...part.data });
                        break;
                    default: {
                        const unhandled: never = part;
                        throw new Error(`stored display part has no chat-part arm: ${String(unhandled)}`);
                    }
                }
            }
        }
        if (parts.length === 0) continue;
        const chat: ChatMessage = {
            id: message.id,
            role: message.role,
            parts,
        };
        if (message.metadata?.interrupted) chat.interrupted = true;
        out.push(chat);
    }
    return out;
}
