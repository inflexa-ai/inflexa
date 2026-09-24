/**
 * `read_tool_output` — reads the kept text of a tool result that the loop cut, by a window or by a pattern.
 * Each result stays under the cap of the loop, thus the loop never cuts a result of this tool.
 */

import { ok, type Result } from "neverthrow";
import { z } from "zod";

import { unwrapOrThrow } from "../lib/result.js";
import { pairSafeIndex, READ_TOOL_OUTPUT_TOOL_ID, TOOL_RESULT_CAP, type ToolOutputStore } from "../loop/tool-output.js";
import { defineTool, type Tool, type ToolError } from "./define-tool.js";

const DEFAULT_PAGE_CHARS = 8 * 1024;
const MAX_PAGE_CHARS = 16 * 1024;
const MAX_MATCHES = 20;
const MATCH_CHARS_BEFORE = 150;
const MATCH_CHARS_AFTER = 250;
/** The loop JSON-escapes the text of a result, and an escape can make a text two to six times longer. */
const RESULT_BUDGET = TOOL_RESULT_CAP - 512;

interface Match {
    readonly offset: number;
    readonly text: string;
}

type ReadToolOutputResult =
    | { status: "ok"; ref: string; offset: number; end: number; keptLength: number; more: boolean; text: string }
    | { status: "matches"; ref: string; pattern: string; offset: number; end: number; keptLength: number; more: boolean; matches: Match[] }
    | { status: "no_matches"; ref: string; pattern: string; offset: number; end: number }
    | { status: "not_found"; ref: string }
    | { status: "out_of_range"; ref: string; offset: number; keptLength: number }
    | { status: "invalid_pattern"; pattern: string; error: string };

const ReadToolOutputInputSchema = z.object({
    ref: z.string().min(1).max(64).describe("The reference that the excerpt of a cut tool result gives, for example to_3f9a2c41b8d605e7a1c0."),
    offset: z.number().int().min(0).optional().describe("The index of the first character of the window, from 0. Defaults to 0."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE_CHARS)
        .optional()
        .describe(`The count of characters of the window. A page defaults to ${DEFAULT_PAGE_CHARS}. A search with no limit reaches the end of the text.`),
    pattern: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe("A JavaScript regular expression. The result gives each match in the window with its offset and the text around it."),
});

/** The end of a window of `length` characters from `start`, off the middle of a surrogate pair, and past `start`. */
function windowEnd(text: string, start: number, length: number): number {
    const end = Math.min(text.length, start + length);
    const safe = pairSafeIndex(text, end, -1);
    return safe > start ? safe : pairSafeIndex(text, end, 1);
}

function fits(result: ReadToolOutputResult): boolean {
    return JSON.stringify(result).length <= RESULT_BUDGET;
}

function page(ref: string, text: string, start: number, limit: number): ReadToolOutputResult {
    const at = (stoppedAt: number): ReadToolOutputResult => ({
        status: "ok",
        ref,
        offset: start,
        end: stoppedAt,
        keptLength: text.length,
        more: stoppedAt < text.length,
        text: text.slice(start, stoppedAt),
    });
    let end = windowEnd(text, start, limit);
    let result = at(end);
    while (!fits(result)) {
        end = windowEnd(text, start, Math.floor(((end - start) * 3) / 4));
        result = at(end);
    }
    return result;
}

function search(ref: string, text: string, start: number, limit: number | undefined, pattern: string): ReadToolOutputResult {
    let regex: RegExp;
    try {
        regex = new RegExp(pattern, "g");
    } catch (err) {
        return { status: "invalid_pattern", pattern, error: err instanceof Error ? err.message : String(err) };
    }

    const stop = limit === undefined ? text.length : windowEnd(text, start, limit);
    const window = text.slice(start, stop);
    const matches: Match[] = [];
    let end = stop;
    for (let found = regex.exec(window); found !== null; found = regex.exec(window)) {
        const offset = start + found.index;
        // A match past the last one that the result can hold is where the next call continues.
        if (matches.length === MAX_MATCHES) {
            end = offset;
            break;
        }
        const from = pairSafeIndex(text, Math.max(0, offset - MATCH_CHARS_BEFORE), 1);
        const to = pairSafeIndex(text, Math.min(text.length, offset + MATCH_CHARS_AFTER), -1);
        matches.push({ offset, text: text.slice(from, to) });
        if (found[0].length === 0) regex.lastIndex++;
    }
    if (matches.length === 0) return { status: "no_matches", ref, pattern, offset: start, end };

    const at = (stoppedAt: number): ReadToolOutputResult => ({
        status: "matches",
        ref,
        pattern,
        offset: start,
        end: stoppedAt,
        keptLength: text.length,
        more: stoppedAt < text.length,
        matches: [...matches],
    });
    let result = at(end);
    while (!fits(result) && matches.length > 1) {
        end = matches.pop()!.offset;
        result = at(end);
    }
    return result;
}

export function createReadToolOutputTool(store: ToolOutputStore): Tool {
    return defineTool({
        id: READ_TOOL_OUTPUT_TOOL_ID,
        description:
            "Read the full text of a tool result that came back as an excerpt. A result longer than the limit of the context " +
            "comes back as its start and its end, and the excerpt gives a reference when the harness kept the whole text. " +
            "Pass that reference as `ref`. Read a window with `offset` and `limit`: an offset counts the characters " +
            `(UTF-16 code units) of the kept text from 0, and a page has at most ${MAX_PAGE_CHARS} characters, ` +
            `${DEFAULT_PAGE_CHARS} by default. Or give \`pattern\`, a JavaScript regular expression, to get at most ` +
            `${MAX_MATCHES} matches, each with its offset and the text around it. When a result gives \`more: true\`, ` +
            "call again with `offset` set to its `end`.",
        inputSchema: ReadToolOutputInputSchema,
        // The reference alone repeats across the pages of one text, and the pattern is what tells two searches apart.
        describeCall: ({ ref, pattern }) => (pattern === undefined ? ref : `${pattern} in ${ref}`),
        execute: async ({ ref, offset = 0, limit, pattern }, ctx): Promise<Result<ReadToolOutputResult, ToolError>> => {
            // The analysis of the session scopes the read, thus a reference cannot reach a text of a different analysis.
            const kept = unwrapOrThrow(await store.get(ctx.session.scope.analysisId, ref));
            if (kept === null) return ok({ status: "not_found", ref });
            const text = kept.content;
            if (offset >= text.length) return ok({ status: "out_of_range", ref, offset, keptLength: text.length });
            const start = pairSafeIndex(text, offset, -1);
            return ok(pattern === undefined ? page(ref, text, start, limit ?? DEFAULT_PAGE_CHARS) : search(ref, text, start, limit, pattern));
        },
    });
}
