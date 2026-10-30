/**
 * The shown values of a tool call: its input, its result, and its error.
 *
 * The emit site makes each value one time, and a host only shows it. The steps run in this order, because each step
 * protects the next one: the control characters go first, thus a control byte inside a secret cannot stop a pattern.
 * The secrets go before the cut, thus a cut cannot divide a secret and let one half pass. The shown text can differ
 * from the text that the model reads.
 */

import type { ToolCallValue } from "../contracts/chat-events.js";
import { isUnknownArray } from "../lib/unknown-array.js";
import { parseJsonAs } from "../lib/parse-json.js";
import { parseUnknownRecord, UnknownRecordSchema } from "../lib/unknown-containers.js";
import { normalizeUnicode, redactSecretAssignments, redactSecretFields, redactSecrets } from "../input-sanitization.js";
import type { EmitEvent } from "./types.js";
import { pairSafeIndex } from "./tool-output.js";
import type { ChatStreamEvent } from "../providers/types.js";

/** A text longer than this is cut. The unit is the UTF-16 code unit. */
export const TOOL_VALUE_CAP = 8 * 1024;

/** The start of a cut text holds the shape of a value. */
export const TOOL_VALUE_HEAD_CHARS = 3 * 1024;

/** The end of a cut text holds the errors of a command, thus it gets more room than the start. */
export const TOOL_VALUE_TAIL_CHARS = 5 * 1024;

/**
 * The text past each shown part that the rules also read. A secret at the edge of a shown part is whole in its window
 * when it is shorter than this margin, thus the rules see it as they see it in the whole text.
 */
export const TOOL_VALUE_CLEAN_MARGIN = 8 * 1024;

const HEAD_WINDOW = TOOL_VALUE_HEAD_CHARS + TOOL_VALUE_CLEAN_MARGIN;
const TAIL_WINDOW = TOOL_VALUE_TAIL_CHARS + TOOL_VALUE_CLEAN_MARGIN;

/**
 * A text up to this length gets the rules whole. A longer text gets them on its two windows only, thus the cost of a
 * value does not grow with the size of a result.
 */
const WHOLE_CLEAN_MAX = HEAD_WINDOW + TAIL_WINDOW;

function cleanText(text: string): string {
    return redactSecrets(redactSecretAssignments(normalizeUnicode(text)));
}

function cleanStrings(value: unknown): unknown {
    if (typeof value === "string") return cleanText(value);
    if (isUnknownArray(value)) return value.map(cleanStrings);
    const record = parseUnknownRecord(value);
    if (record === undefined) return value;
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(record)) out[cleanText(name)] = cleanStrings(field);
    return out;
}

/** The shown start of `head` and the shown end of `tail`, with a marker that counts the code units of `length` not shown. */
function cutParts(head: string, tail: string, length: number): ToolCallValue {
    const shownHead = head.slice(0, pairSafeIndex(head, TOOL_VALUE_HEAD_CHARS, -1));
    const shownTail = tail.slice(pairSafeIndex(tail, Math.max(0, tail.length - TOOL_VALUE_TAIL_CHARS), 1));
    const marker = `[... ${Math.max(0, length - shownHead.length - shownTail.length)} characters not shown ...]`;
    return { text: `${shownHead}\n${marker}\n${shownTail}`, cut: true };
}

function cutText(clean: string): ToolCallValue {
    return clean.length <= TOOL_VALUE_CAP ? { text: clean, cut: false } : cutParts(clean, clean, clean.length);
}

/** The shown text of a plain text. A long text gets the rules on its two windows, and its marker counts the original text. */
function shownText(text: string): ToolCallValue {
    if (text.length <= WHOLE_CLEAN_MAX) return cutText(cleanText(text));
    const head = cleanText(text.slice(0, pairSafeIndex(text, HEAD_WINDOW, -1)));
    const tail = cleanText(text.slice(pairSafeIndex(text, text.length - TAIL_WINDOW, 1)));
    return cutParts(head, tail, text.length);
}

/** The JSON text of a value, or `undefined` for a function, a symbol, and `undefined`, which the lib type omits. */
function jsonText(value: unknown): string | undefined {
    return JSON.stringify(value);
}

function serializeClean(value: unknown): string {
    return jsonText(cleanStrings(redactSecretFields(value)) ?? null) ?? "null";
}

/** The fields of a plain record whose JSON text is its own fields, or `undefined` for each other value. */
function plainFields(value: unknown): Array<[string, unknown]> | undefined {
    if (value === null || value === undefined) return undefined;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const fields: Array<[string, unknown]> = Object.entries(value);
    return fields.some(([name, field]) => name === "toJSON" && typeof field === "function") ? undefined : fields;
}

/**
 * A copy of one end of `value`: the JSON text of the copy starts (`head`) or ends (`tail`) with at least `budget.left`
 * code units of the JSON text of `value`. The count of a string ignores its escapes, and an escape only makes the text
 * longer, thus the copy never holds less than the budget. A value that is not an array, a plain record, or a string
 * stays whole, because its JSON text comes from its own `toJSON`.
 */
function endOf(value: unknown, budget: { left: number }, end: "head" | "tail"): unknown {
    if (typeof value === "string") {
        const keep = Math.max(0, budget.left);
        const kept = end === "head" ? value.slice(0, keep) : value.slice(Math.max(0, value.length - keep));
        budget.left -= kept.length + 2;
        return kept;
    }
    if (isUnknownArray(value)) {
        budget.left -= 2;
        const kept: unknown[] = [];
        for (let index = 0; index < value.length && budget.left > 0; index += 1) {
            kept.push(endOf(value[end === "head" ? index : value.length - 1 - index], budget, end));
            budget.left -= 1;
        }
        return end === "head" ? kept : kept.reverse();
    }
    const fields = plainFields(value);
    if (fields !== undefined) {
        budget.left -= 2;
        const kept: Array<[string, unknown]> = [];
        for (let index = 0; index < fields.length && budget.left > 0; index += 1) {
            const entry = fields[end === "head" ? index : fields.length - 1 - index];
            // JSON text omits such a field, and a test of the field by its own serialization would read all of it.
            if (entry === undefined || entry[1] === undefined || typeof entry[1] === "function" || typeof entry[1] === "symbol") continue;
            budget.left -= entry[0].length + 4;
            kept.push([entry[0], endOf(entry[1], budget, end)]);
        }
        return Object.fromEntries(end === "head" ? kept : kept.reverse());
    }
    budget.left -= jsonText(value)?.length ?? 0;
    return value;
}

/** The value of a plain text: control characters out, each secret out, then the cut. */
export function textToolValue(text: string): ToolCallValue {
    return shownText(text);
}

/**
 * The value of a JSON value. A string shows as the string itself, and each other value shows as its JSON text.
 * The field-name rule runs first, then the text rules on each string, then the serialization, then the cut: a text
 * rule never meets a JSON escape, which would hide the end of a quoted secret.
 * A long JSON text gets the rules on a copy of each end of the value only, and its marker counts the JSON text of the
 * original value. Only the serialization of the whole value grows with its size, and the model path pays it already.
 * A value that does not serialize, for example a cycle, gives no value: a value is a diagnostic and never fails a call.
 */
export function jsonToolValue(value: unknown): ToolCallValue | undefined {
    try {
        if (typeof value === "string") return shownText(value);
        const raw = jsonText(value ?? null);
        if (raw === undefined) return undefined;
        if (raw.length <= WHOLE_CLEAN_MAX) return cutText(serializeClean(value));
        const head = serializeClean(endOf(value, { left: HEAD_WINDOW }, "head"));
        const tail = serializeClean(endOf(value, { left: TAIL_WINDOW }, "tail"));
        return cutParts(head, tail, raw.length);
    } catch {
        return undefined;
    }
}

/**
 * The value of an error text. The adapter writes the error of a tool as a JSON object, and that text is a JSON value.
 * Each other error text is a plain text.
 */
export function errorToolValue(text: string): ToolCallValue | undefined {
    let record: Record<string, unknown>;
    try {
        record = parseJsonAs(text, UnknownRecordSchema);
    } catch {
        return textToolValue(text);
    }
    return jsonToolValue(record);
}

/**
 * The event without the three values. A forwarder of loop events to the stream of a run calls it, because no reader
 * of that stream shows a value, and a value costs bytes on each event.
 */
export function withoutToolValues(event: EmitEvent | ChatStreamEvent): EmitEvent | ChatStreamEvent {
    switch (event.type) {
        case "tool-started": {
            const { inputValue: _input, ...rest } = event;
            return rest;
        }
        case "tool-finished": {
            const { inputValue: _input, resultValue: _result, errorValue: _error, ...rest } = event;
            return rest;
        }
        default:
            return event;
    }
}
