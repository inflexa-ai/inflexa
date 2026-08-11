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
 * The token-bearing text of one tool-result output.
 *
 * A `content` output holds the text parts and the attachments side by side. Only
 * the text is prompt text. A file rides the wire as an attachment, and the
 * provider bills it at its own rate, thus its bytes count as `0` — the same rule
 * as a top-level `file` block. A file that is stringified into the count inflates
 * the row of the message by tens of thousands of tokens, and the load window then
 * drops the true history.
 *
 * Each other output arm is plain JSON, thus it is stringified whole.
 */
function toolResultText(output: unknown): string {
    if (typeof output !== "object" || output === null) return JSON.stringify(output ?? {});
    const out = output as Record<string, unknown>;
    if (out.type !== "content" || !Array.isArray(out.value)) return JSON.stringify(out);
    const texts: string[] = [];
    for (const item of out.value) {
        if (typeof item !== "object" || item === null) continue;
        const nested = item as Record<string, unknown>;
        if (nested.type === "text" && typeof nested.text === "string") texts.push(nested.text);
    }
    return texts.join(" ");
}

/**
 * The token-bearing text of one content block. A text-carrying field is
 * extracted directly. A `tool_use` input is JSON-stringified, and a
 * `tool_result` output goes through {@link toolResultText}. A signed `thinking`
 * block counts only its reasoning text, because the opaque `signature` is
 * metadata and not prompt tokens.
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
            return `${String(part.toolName ?? "")} ${toolResultText(part.output)}`;
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
