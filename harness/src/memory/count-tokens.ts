/**
 * Token counting for the conversation. The store stamps the count of each message
 * row as its `tokens` column, and the loop estimates the view of a request with the
 * same count. `loadRecent` has no budget.
 *
 * Providers do not publish one shared offline tokenizer,
 * so this uses `js-tiktoken`'s `cl100k_base` BPE. It is an approximation:
 * callers treat the budget as a soft target with a safety margin below the
 * true context limit.
 */

import { textOf } from "../lib/unknown-text.js";
import type { ModelMessage } from "ai";
import { getEncoding, type Tiktoken } from "js-tiktoken";

import { parseUnknownRecord } from "../lib/unknown-containers.js";

let encoder: Tiktoken | undefined;

function enc(): Tiktoken {
    encoder ??= getEncoding("cl100k_base");
    return encoder;
}

/**
 * A run of this many characters with no whitespace is counted in chunks. The BPE merge of `js-tiktoken` is
 * quadratic in the length of one pre-token, and a run of one repeated character of 20,000 characters takes
 * about 13 s whole. A base64 blob or a sequence with no line break is such a run in a tool result.
 */
// oxlint-disable-next-line eslint-js/no-restricted-syntax -- a run of 256 or more characters with no whitespace; no builtin finds a run by its length.
const LONG_RUN = /\S{256,}/g;

/** The chunk of a long run. A chunk of 64 characters costs well under a millisecond in the worst case. */
const RUN_CHUNK = 64;

/**
 * The token count of one text. A text with no long run is one encoding, thus its count is exact. Each long run
 * is counted in chunks, which can add a token at each chunk edge: the count is an approximation already.
 */
function encodedLength(text: string): number {
    let total = 0;
    let from = 0;
    for (const run of text.matchAll(LONG_RUN)) {
        if (run.index > from) total += enc().encode(text.slice(from, run.index)).length;
        for (let at = 0; at < run[0].length; at += RUN_CHUNK) total += enc().encode(run[0].slice(at, at + RUN_CHUNK)).length;
        from = run.index + run[0].length;
    }
    if (from < text.length) total += enc().encode(text.slice(from)).length;
    return total;
}

/**
 * The token-bearing text of one tool-result output.
 *
 * A `content` output holds the text parts and the attachments side by side. Only
 * the text is prompt text. A file rides the wire as an attachment, and the
 * provider bills it at its own rate, thus its bytes count as `0` — the same rule
 * as a top-level `file` block. A file that is stringified into the count inflates
 * the row of the message by tens of thousands of tokens, and the loop then
 * compacts the view too early.
 *
 * Each other output arm is plain JSON, thus it is stringified whole.
 */
function toolResultText(output: unknown): string {
    const out = parseUnknownRecord(output);
    if (out === undefined) return JSON.stringify(output ?? {});
    if (out.type !== "content" || !Array.isArray(out.value)) return JSON.stringify(out);
    const texts: string[] = [];
    for (const item of out.value) {
        const nested = parseUnknownRecord(item);
        if (nested === undefined) continue;
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
    const part = parseUnknownRecord(block);
    if (part === undefined) return JSON.stringify(block);
    switch (part.type) {
        case "text":
            return typeof part.text === "string" ? part.text : "";
        case "reasoning":
            return typeof part.text === "string" ? part.text : "";
        case "reasoning-file":
        case "custom":
        case "file":
        case "image":
            return "";
        case "tool-call":
            return `${textOf(part.toolName ?? "")} ${JSON.stringify(part.input ?? {})}`;
        case "tool-result": {
            return `${textOf(part.toolName ?? "")} ${toolResultText(part.output)}`;
        }
        default:
            return JSON.stringify(part);
    }
}

/**
 * Token count of a message's content. Empty content (an empty array or empty
 * string) counts as `0`.
 */
export function countTokens(content: ModelMessage["content"]): number {
    if (typeof content === "string") {
        return content.length === 0 ? 0 : encodedLength(content);
    }
    let total = 0;
    for (const block of content) {
        const text = tokenizableText(block);
        if (text.length > 0) total += encodedLength(text);
    }
    return total;
}
