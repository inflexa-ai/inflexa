/**
 * Write-time token counting for the conversation message store.
 *
 * `appendTurn` stamps a `tokens` count on every message row so `loadRecent`
 * windows by token budget without tokenizing on the read path. Counted once
 * at write, applied at load.
 *
 * Providers do not publish one shared offline tokenizer,
 * so this uses `js-tiktoken`'s `cl100k_base` BPE. It is an approximation:
 * callers treat the budget as a soft target with a safety margin below the
 * true context limit.
 */

import type { ModelMessage } from "ai";
import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | undefined;

function enc(): Tiktoken {
    encoder ??= getEncoding("cl100k_base");
    return encoder;
}

/**
 * The token-bearing text of one content block. Text-carrying fields are
 * extracted directly; structural blocks (`tool_use` input, `tool_result`
 * payload) are JSON-stringified. A signed `thinking` block counts only its
 * reasoning text — the opaque `signature` is metadata, not prompt tokens.
 */
function tokenizableText(block: unknown): string {
    if (typeof block === "string") return block;
    if (typeof block !== "object" || block === null) return JSON.stringify(block);
    const part = block as Record<string, unknown>;
    switch (part.type) {
        case "text":
            return typeof part.text === "string" ? part.text : "";
        case "reasoning":
            return typeof part.text === "string" ? part.text : "";
        case "reasoning-file":
        case "custom":
        case "file":
            return "";
        case "tool-call":
            return `${String(part.toolName ?? "")} ${JSON.stringify(part.input ?? {})}`;
        case "tool-result": {
            return `${String(part.toolName ?? "")} ${JSON.stringify(part.output ?? {})}`;
        }
        default:
            return JSON.stringify(part);
    }
}

/**
 * Token count of a message's content. Used only at write time. Empty
 * content (an empty array or empty string) counts as `0`.
 */
export function countTokens(content: ModelMessage["content"]): number {
    if (typeof content === "string") {
        return content.length === 0 ? 0 : enc().encode(content).length;
    }
    let total = 0;
    for (const block of content) {
        const text = tokenizableText(block);
        if (text.length > 0) total += enc().encode(text).length;
    }
    return total;
}
