/**
 * The cut of a long tool result: the excerpt that the model reads, and the store that keeps the whole text.
 * Each length and each offset counts UTF-16 code units, the unit of a JavaScript string length.
 */

import { createHash } from "node:crypto";

import type { ToolResultPart } from "ai";
import type { ResultAsync } from "neverthrow";

import type { DomainError } from "../lib/result.js";

/** Keeps each skill file whole, because the largest one gives about 29,300 characters. */
export const TOOL_RESULT_CAP = 32 * 1024;

/** The start of an excerpt holds the shape of a result: its status, its first keys, or a header row. */
export const EXCERPT_HEAD_CHARS = 4 * 1024;

/** The end of an excerpt holds the errors and the stream flags of a command, thus it gets two times the start. */
export const EXCERPT_TAIL_CHARS = 8 * 1024;

/** The bound of a file that `grep` reads, thus a pattern search over a kept text costs no more than a `grep`. */
export const TOOL_OUTPUT_KEEP_MAX = 1024 * 1024;

export const READ_TOOL_OUTPUT_TOOL_ID = "read_tool_output";

export interface KeptToolOutput {
    readonly analysisId: string;
    readonly ref: string;
    readonly toolName: string;
    readonly toolCallId: string;
    /** Absent for a loop of a run, because a run belongs to its analysis and not to a thread. */
    readonly threadId?: string;
    /** The whole text, or its two halves with a marker line between them. */
    readonly content: string;
    /** The length of the whole text of the result. */
    readonly totalLength: number;
}

/** Keeps the text of each cut tool result for `read_tool_output`. */
export interface ToolOutputStore {
    /** A second put of the same analysis id and reference replaces the text. */
    put(output: KeptToolOutput): ResultAsync<void, DomainError>;
    get(analysisId: string, ref: string): ResultAsync<KeptToolOutput | null, DomainError>;
}

/** The reference of one kept text. It is short, because the model copies it. */
export function toolOutputRef(key: string): string {
    return `to_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

/** The text that the model reads for a result, or `undefined` for a denial, which is never cut. */
export function resultTextOf(output: ToolResultPart["output"]): string | undefined {
    switch (output.type) {
        case "json":
        case "error-json":
            return JSON.stringify(output.value);
        case "text":
        case "error-text":
            return output.value;
        case "content":
            return output.value.map((part) => (part.type === "text" ? part.text : "")).join("");
        case "execution-denied":
            return undefined;
    }
}

/** Move `index` by one unit toward `direction` when it falls between the two halves of a surrogate pair. */
export function pairSafeIndex(text: string, index: number, direction: -1 | 1): number {
    if (index <= 0 || index >= text.length) return index;
    const before = text.charCodeAt(index - 1);
    const after = text.charCodeAt(index);
    const splitsPair = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
    return splitsPair ? index + direction : index;
}

export function keptTextOf(text: string): string {
    if (text.length <= TOOL_OUTPUT_KEEP_MAX) return text;
    const headEnd = pairSafeIndex(text, TOOL_OUTPUT_KEEP_MAX / 2, -1);
    const tailStart = pairSafeIndex(text, text.length - TOOL_OUTPUT_KEEP_MAX / 2, 1);
    return `${text.slice(0, headEnd)}\n[... ${tailStart - headEnd} characters not kept ...]\n${text.slice(tailStart)}`;
}

/** The excerpt of a text longer than `TOOL_RESULT_CAP`. `kept` is absent when the loop kept no text. */
export function excerptOf(text: string, kept: { readonly ref: string; readonly keptLength: number } | undefined): string {
    const headEnd = pairSafeIndex(text, EXCERPT_HEAD_CHARS, -1);
    const tailStart = pairSafeIndex(text, text.length - EXCERPT_TAIL_CHARS, 1);
    const shown = `Shown: the first ${headEnd} and the last ${text.length - tailStart} characters.`;
    const lines = [
        `[Tool result cut: ${text.length} characters, over the limit of ${TOOL_RESULT_CAP}. ${shown}${kept === undefined ? " The rest is not kept." : ""}]`,
    ];
    if (kept !== undefined) {
        lines.push(
            `[The harness kept ${kept.keptLength} characters as reference "${kept.ref}". Call ${READ_TOOL_OUTPUT_TOOL_ID} with this reference and an offset and a limit, or with a pattern. Offsets start at 0.]`,
        );
    }
    lines.push(text.slice(0, headEnd), `[... ${tailStart - headEnd} characters not shown ...]`, text.slice(tailStart));
    return lines.join("\n");
}

/** The result with `excerpt` in place of its text. A part of a JSON text is not valid JSON, thus a JSON result becomes text. */
export function withExcerpt(part: ToolResultPart, excerpt: string): ToolResultPart {
    const { output } = part;
    switch (output.type) {
        case "json":
        case "text":
            return { ...part, output: { type: "text", value: excerpt } };
        case "error-json":
        case "error-text":
            return { ...part, output: { type: "error-text", value: excerpt } };
        case "content":
            return { ...part, output: { type: "content", value: [{ type: "text", text: excerpt }, ...output.value.filter((p) => p.type !== "text")] } };
        case "execution-denied":
            return part;
    }
}
