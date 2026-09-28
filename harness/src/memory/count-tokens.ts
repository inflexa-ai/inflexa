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

import type { ModelMessage } from "ai";
import { getEncoding, type Tiktoken } from "js-tiktoken";

import { imageDimensions } from "./image-dimensions.js";

let encoder: Tiktoken | undefined;

function enc(): Tiktoken {
    encoder ??= getEncoding("cl100k_base");
    return encoder;
}

/** The count of an image whose header gives no size: about the most that Anthropic bills for one image after its scale-down. */
export const UNKNOWN_IMAGE_TOKENS = 1_600;

/** The pixels of one image token, by the rule that Anthropic publishes. */
const PIXELS_PER_IMAGE_TOKEN = 750;

function imageTokens(data: unknown): number {
    const size = imageDimensions(data);
    return size === undefined ? UNKNOWN_IMAGE_TOKENS : Math.ceil((size.width * size.height) / PIXELS_PER_IMAGE_TOKEN);
}

function isImageMediaType(mediaType: unknown): boolean {
    return typeof mediaType === "string" && (mediaType === "image" || mediaType.startsWith("image/"));
}

/** The data of a file: the `data` arm of the tagged union, or the raw data. A URL or a reference gives `undefined`. */
function fileDataOf(data: unknown): unknown {
    if (typeof data !== "object" || data === null || data instanceof Uint8Array || data instanceof ArrayBuffer) return data;
    const tagged = data as Record<string, unknown>;
    return tagged.type === "data" ? tagged.data : undefined;
}

/** The count of the images of one block. Each other file counts as `0`, because the provider bills it at its own rate. */
function blockImageTokens(block: unknown): number {
    if (typeof block !== "object" || block === null) return 0;
    const part = block as Record<string, unknown>;
    if (part.type === "image") return imageTokens(fileDataOf(part.image));
    if (part.type === "file") return isImageMediaType(part.mediaType) ? imageTokens(fileDataOf(part.data)) : 0;
    if (part.type !== "tool-result" || typeof part.output !== "object" || part.output === null) return 0;
    const output = part.output as Record<string, unknown>;
    if (output.type !== "content" || !Array.isArray(output.value)) return 0;
    let total = 0;
    for (const item of output.value) {
        if (typeof item !== "object" || item === null) continue;
        const nested = item as Record<string, unknown>;
        const type = String(nested.type);
        if (!type.startsWith("image-") && !isImageMediaType(nested.mediaType)) continue;
        const data = type === "file" ? fileDataOf(nested.data) : type === "image-data" || type === "file-data" ? nested.data : undefined;
        total += imageTokens(data);
    }
    return total;
}

/**
 * The token-bearing text of one tool-result output. Of a `content` output, only the text parts:
 * a stringified file inflates the row by tens of thousands of tokens. Each other arm is plain JSON.
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
        case "image":
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
 * Token count of a message's content. Empty content (an empty array or empty
 * string) counts as `0`. An image counts by its pixel area.
 */
export function countTokens(content: ModelMessage["content"]): number {
    if (typeof content === "string") {
        return content.length === 0 ? 0 : enc().encode(content).length;
    }
    let total = 0;
    for (const block of content) {
        const text = tokenizableText(block);
        if (text.length > 0) total += enc().encode(text).length;
        total += blockImageTokens(block);
    }
    return total;
}
