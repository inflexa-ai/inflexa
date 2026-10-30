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

function cutText(clean: string): ToolCallValue {
    if (clean.length <= TOOL_VALUE_CAP) return { text: clean, cut: false };
    const headEnd = pairSafeIndex(clean, TOOL_VALUE_HEAD_CHARS, -1);
    const tailStart = pairSafeIndex(clean, clean.length - TOOL_VALUE_TAIL_CHARS, 1);
    const marker = `[... ${tailStart - headEnd} characters not shown ...]`;
    return { text: `${clean.slice(0, headEnd)}\n${marker}\n${clean.slice(tailStart)}`, cut: true };
}

/** The value of a plain text: control characters out, each secret out, then the cut. */
export function textToolValue(text: string): ToolCallValue {
    return cutText(cleanText(text));
}

/**
 * The value of a JSON value. A string shows as the string itself, and each other value shows as its JSON text.
 * The field-name rule runs first, then the text rules on each string, then the serialization, then the cut: a text
 * rule never meets a JSON escape, which would hide the end of a quoted secret.
 * A value that does not serialize, for example a cycle, gives no value: a value is a diagnostic and never fails a call.
 */
export function jsonToolValue(value: unknown): ToolCallValue | undefined {
    try {
        const clean = cleanStrings(redactSecretFields(value));
        return cutText(typeof clean === "string" ? clean : JSON.stringify(clean ?? null));
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
