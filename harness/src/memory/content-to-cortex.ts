/**
 * Converter: stored AI SDK model messages → wire `CortexMessage[]`.
 *
 * The display read (`ThreadHistory.loadPage`) returns rows whose `content`
 * is the AI SDK `ModelMessage` that `appendTurn` persisted. This maps each
 * row to a `CortexMessage` for the chat wire:
 *
 *   - text part         → text part
 *   - tool-call part    → a reconstructed display card (`data-plan`,
 *                         `data-presentation`) when `resolveCard` recognises
 *                         the tool, else a generic tool-call part
 *   - everything else   → dropped (reasoning, tool-result, etc.) — the UI
 *                         does not render them
 *
 * Display cards are emitted live over the chat SSE stream but never persisted
 * (storage holds only the AI SDK model-message transcript). `resolveCard`
 * rebuilds them from the persisted tool-call part so they reappear on reload,
 * and `resolveDetail` rebuilds each call's one-line detail the same way.
 *
 * A `tool-result` block is not rendered, but it is not ignored either: it is the
 * only record of how its call ended. The blocks are indexed by `toolCallId`
 * before conversion so each tool-call part can report its own outcome — without
 * that pass every reloaded call reported success, including the failed ones.
 *
 * A row that yields no renderable parts (e.g. a `tool`-role message carrying
 * only tool-result continuation parts) is omitted entirely, so the rendered
 * conversation has no empty bubbles. Storage is never mutated.
 */

import type { ModelMessage } from "ai";
import type { CortexMessage, CortexPart } from "@inflexa-ai/harness/contracts/message.js";
import type { ToolOutcome } from "@inflexa-ai/harness/contracts/chat-events.js";

import { toolOutcomeForOutputType } from "../loop/tool-outcome.js";
import type { ToolDetailResolver } from "../tools/detail-resolver.js";
import { isInterruptedMessage, isSyntheticRecordMessage, isSyntheticUserMessage } from "./ai-sdk-message-storage.js";
import type { ToolCardResolver } from "./reconstruct-cards.js";
import type { StoredMessage } from "./thread-history.js";

/**
 * The resolvers a caller may supply, as one object.
 *
 * An options bag rather than a growing positional list: both are optional, both
 * are function-typed, and a second positional parameter of the same shape is a
 * call site that silently does the wrong thing when the two are swapped.
 */
export interface ContentToCortexOptions {
    /** Rebuilds a display card (`data-plan`, `data-presentation`) from a persisted tool call. */
    readonly resolveCard?: ToolCardResolver;
    /** Rebuilds a call's one-line detail from its tool name and persisted input. */
    readonly resolveDetail?: ToolDetailResolver;
}

type ToolCallBlock = Extract<Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number], { type: "tool-call" }>;

/**
 * How each stored call ended, keyed by tool-call id.
 *
 * A whole page is indexed before conversion because the pairing crosses rows: a
 * call rides an `assistant` row and its result rides the `tool` row after it.
 */
function indexOutcomes(messages: readonly StoredMessage[]): Map<string, ToolOutcome> {
    const outcomes = new Map<string, ToolOutcome>();
    for (const { message } of messages) {
        const content = message.content;
        if (typeof content === "string") continue;
        for (const block of content) {
            if (block.type !== "tool-result") continue;
            outcomes.set(block.toolCallId, toolOutcomeForOutputType(block.output.type));
        }
    }
    return outcomes;
}

function genericToolCall(block: ToolCallBlock, outcomes: Map<string, ToolOutcome>, resolveDetail?: ToolDetailResolver): CortexPart {
    // No paired result is the shape of a transcript whose `tool` row was never
    // appended (an aborted turn). Nothing failed, so `ok` is the honest report.
    const outcome = outcomes.get(block.toolCallId) ?? "ok";
    const detail = resolveDetail?.(block.toolName, block.input);
    return {
        type: "tool-call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        status: "finished",
        outcome,
        ...(detail === undefined ? {} : { detail }),
    };
}

async function blockToPart(
    block: Exclude<ModelMessage["content"], string>[number],
    outcomes: Map<string, ToolOutcome>,
    options: ContentToCortexOptions,
): Promise<CortexPart | null> {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool-call") {
        const card = options.resolveCard
            ? await options.resolveCard({ type: "tool_use", id: block.toolCallId, name: block.toolName, input: block.input } as never)
            : null;
        return card ?? genericToolCall(block, outcomes, options.resolveDetail);
    }
    // reasoning, tool_result, file, and any other block — not rendered.
    return null;
}

async function rowToParts(message: StoredMessage["message"], outcomes: Map<string, ToolOutcome>, options: ContentToCortexOptions): Promise<CortexPart[]> {
    const content = message.content;
    if (typeof content === "string") {
        return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    const parts: CortexPart[] = [];
    for (const block of content) {
        const part = await blockToPart(block, outcomes, options);
        if (part) parts.push(part);
    }
    return parts;
}

/**
 * Map stored messages (oldest-first) to `CortexMessage[]`. Rows that produce
 * no renderable parts are dropped, and consecutive assistant rows are coalesced
 * into one message. The first row's `seq` becomes the stable message id.
 * `options.resolveCard` reconstructs display cards from `tool_use` blocks and
 * `options.resolveDetail` reconstructs each call's one-line detail; both are
 * optional and each tool-call part reports its outcome either way.
 * A row carrying the interruption marker sets `interrupted: true` on the message
 * it lands in, including when coalesced into an assistant run.
 *
 * Coalescing mirrors the live SSE shape. The agent loop persists each assistant
 * step (typically a single `tool_use`) as its own row, and the `tool_result`
 * `user` rows between them drop to zero renderable parts above — so one assistant
 * turn is stored as a run of adjacent assistant rows. The live chat stream
 * accumulates that whole turn into a single assistant message whose `parts` hold
 * every step; reconstructing it row-by-row instead would emit one message per
 * tool call, which the UI renders as a stack of single-tool boxes. Merging the
 * run restores the one-bubble-per-turn shape (and lets the UI collapse the tool
 * calls into one group) regardless of how the loop split the turn into rows.
 *
 * Coalescing is assistant-only. User rows never legitimately split into a run —
 * adjacent `user` rows arise only from turns that persisted no reply (an aborted
 * turn's lone user message followed by the next turn's), and merging them would
 * fabricate one bubble from two messages the user sent separately.
 */
export async function contentToCortexMessages(messages: readonly StoredMessage[], options: ContentToCortexOptions = {}): Promise<CortexMessage[]> {
    const outcomes = indexOutcomes(messages);
    const out: CortexMessage[] = [];
    for (const message of messages) {
        // The loop's truncation nudge carries the `user` role only for the wire
        // format; rendering it would show words the user never typed, so drop it.
        // Skipping first is safe: a synthetic user message can never carry the
        // interruption marker — that rides assistant rows — so this cannot interact
        // with the marker-fold logic below. The assistant rows it separated then
        // become adjacent and coalesce into one bubble, which is the shape we want.
        //
        // A host-appended RECORD is the exception, and the distinction is exactly why the
        // two markers exist separately: it is equally synthetic for every turn-boundary
        // reader, but it is a fact the reader is entitled to see — the only trace in the
        // conversation that out-of-band work happened at all. Dropping it here would make
        // an embedder's durable record write successfully and then be invisible, with
        // nothing to indicate why.
        const isRecord = isSyntheticRecordMessage(message.message);
        if (isSyntheticUserMessage(message.message) && !isRecord) continue;
        const parts = await rowToParts(message.message, outcomes, options);
        // The marker is read before the zero-parts drop so the flag can never be lost to it:
        // a marked row carries an interruption fact regardless of whether it renders any parts.
        // When such a row contributes no bubble of its own, the interruption belongs to the
        // assistant run it trailed, so fold the flag onto the previous emitted assistant.
        const interrupted = isInterruptedMessage(message.message);
        if (parts.length === 0) {
            if (interrupted) {
                const prev = out[out.length - 1];
                if (prev && prev.role === "assistant") prev.interrupted = true;
            }
            continue;
        }
        // A record carries the `user` role for the wire format and for the turn-boundary
        // predicates, but nobody said it. Emitting it AS `user` would attribute
        // system-authored text to the reader — a lie about who spoke, and one that would
        // also mislead them about what they can retract. `system` is what it actually is.
        const role: CortexMessage["role"] = isRecord
            ? "system"
            : message.message.role === "tool"
              ? "assistant"
              : (message.message.role as CortexMessage["role"]);

        const prev = out[out.length - 1];
        if (prev && prev.role === role && role === "assistant") {
            prev.parts.push(...parts);
            if (interrupted) prev.interrupted = true;
            continue;
        }
        const cortex: CortexMessage = { id: String(message.seq), role, parts };
        if (interrupted) cortex.interrupted = true;
        out.push(cortex);
    }
    return out;
}
