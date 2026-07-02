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
 * rebuilds them from the persisted tool-call part so they reappear on reload.
 *
 * A row that yields no renderable parts (e.g. a `tool`-role message carrying
 * only tool-result continuation parts) is omitted entirely, so the rendered
 * conversation has no empty bubbles. Storage is never mutated.
 */

import type { ModelMessage } from "ai";
import type { CortexMessage, CortexPart } from "@inflexa-ai/harness/contracts/message.js";

import type { ToolCardResolver } from "./reconstruct-cards.js";
import type { StoredMessage } from "./thread-history.js";

function genericToolCall(block: Extract<Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>[number], { type: "tool-call" }>): CortexPart {
    return {
        type: "tool-call",
        toolCallId: block.toolCallId,
        toolName: block.toolName,
        status: "finished",
    };
}

async function blockToPart(block: Exclude<ModelMessage["content"], string>[number], resolveCard?: ToolCardResolver): Promise<CortexPart | null> {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "tool-call") {
        const card = resolveCard ? await resolveCard({ type: "tool_use", id: block.toolCallId, name: block.toolName, input: block.input } as never) : null;
        return card ?? genericToolCall(block);
    }
    // reasoning, tool_result, file, and any other block — not rendered.
    return null;
}

async function rowToParts(message: StoredMessage["message"], resolveCard?: ToolCardResolver): Promise<CortexPart[]> {
    const content = message.content;
    if (typeof content === "string") {
        return content.length > 0 ? [{ type: "text", text: content }] : [];
    }
    const parts: CortexPart[] = [];
    for (const block of content) {
        const part = await blockToPart(block, resolveCard);
        if (part) parts.push(part);
    }
    return parts;
}

/**
 * Map stored messages (oldest-first) to `CortexMessage[]`. Rows that produce
 * no renderable parts are dropped, and consecutive same-role rows are coalesced
 * into one message. The first row's `seq` becomes the stable message id.
 * `resolveCard` (optional) reconstructs display cards from `tool_use` blocks.
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
 */
export async function contentToCortexMessages(messages: readonly StoredMessage[], resolveCard?: ToolCardResolver): Promise<CortexMessage[]> {
    const out: CortexMessage[] = [];
    for (const message of messages) {
        const parts = await rowToParts(message.message, resolveCard);
        if (parts.length === 0) continue;
        const role = message.message.role === "tool" ? "assistant" : (message.message.role as CortexMessage["role"]);

        const prev = out[out.length - 1];
        if (prev && prev.role === role) {
            prev.parts.push(...parts);
            continue;
        }
        out.push({ id: String(message.seq), role, parts });
    }
    return out;
}
