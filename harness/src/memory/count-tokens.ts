/**
 * Write-time token counting for the conversation message store.
 *
 * `appendTurn` stamps a `tokens` count on every message row so `loadRecent`
 * windows by token budget without tokenizing on the read path. Counted once
 * at write, applied at load.
 *
 * Anthropic does not publish an offline tokenizer for the Claude 3/4 family,
 * so this uses `js-tiktoken`'s `cl100k_base` BPE. It is an approximation:
 * callers treat the budget as a soft target with a safety margin below the
 * true context limit.
 */

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
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
function tokenizableText(block: ContentBlockParam): string {
    switch (block.type) {
        case "text":
            return block.text;
        case "thinking":
            return block.thinking;
        case "redacted_thinking":
            return "";
        case "tool_use":
        case "server_tool_use":
            return `${block.name} ${JSON.stringify(block.input)}`;
        case "tool_result": {
            const content = block.content;
            if (content === undefined) return "";
            if (typeof content === "string") return content;
            return content.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join(" ");
        }
        default:
            return JSON.stringify(block);
    }
}

/**
 * Token count of a message's content. Used only at write time. Empty
 * content (an empty array or empty string) counts as `0`.
 */
export function countTokens(content: string | readonly ContentBlockParam[]): number {
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
