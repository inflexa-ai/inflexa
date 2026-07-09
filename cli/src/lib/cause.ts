// The single answer to "what failed" for an unknown thrown / `err` value. Both the cli and the
// harness move failures around as discriminated objects (`{ type, ... }`, e.g. a harness
// `ProviderError` `{ type, retryable, message, cause }`) as well as plain `Error`s, and a naive
// `String(cause)` collapses every structured error to the useless `[object Object]`. This module is
// the one place that knows how to render either shape — a bounded one-liner for a banner/log
// summary ({@link describeCause}) and a full multi-line dump for a details view
// ({@link causeDetailLines}). It mirrors the spirit of the harness's `ResultError.describe`
// (harness/src/lib/result.ts) but adds the `type` discriminant and a bounded `.cause` tail.

/** Longest one-line JSON fallback before it is truncated with an ellipsis — a banner is one line. */
const MAX_ONE_LINE_JSON = 200;
/** Cap the details dump so a pathological object/stack can never flood the dialog. */
const MAX_DETAIL_LINES = 400;
/** Stop walking `Error.cause` after this depth so a self-referential chain cannot loop forever. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Render an unknown failure value as ONE human line for a banner or a log summary. Never
 * `String(object)`. The cases, in order:
 * - an `Error` → `name: message`, with one level of `.cause` appended as ` (cause: …)` when it is
 *   present and adds information beyond the wrapper's own message;
 * - a non-null object carrying a string `type` (the DomainError / discriminated-union convention) →
 *   the `type` discriminant, plus its `message` string field when present (`type: message`);
 * - a string → itself;
 * - any other primitive → `String(cause)` (`"undefined"`, `"null"`, `"42"`, …);
 * - any other object → a bounded, circular-safe `JSON.stringify` (truncated to ~200 chars).
 */
export function describeCause(cause: unknown): string {
    if (cause instanceof Error) {
        const head = errorHeadline(cause);
        const inner = cause.cause;
        if (inner !== undefined && inner !== null) {
            const innerLine = describeShallow(inner);
            // Only append the underlying cause when it says something the wrapper's own message does
            // not already contain — a bare re-echo would just double the same text.
            if (innerLine.length > 0 && !head.includes(innerLine)) return `${head} (cause: ${innerLine})`;
        }
        return head;
    }
    return describeNonError(cause);
}

/** `name: message` for an `Error`, the shared headline both renderers lead with. */
function errorHeadline(error: Error): string {
    return `${error.name}: ${error.message}`;
}

/**
 * Like {@link describeCause} but WITHOUT the `Error.cause` tail — used to render exactly one level
 * of a wrapped error so the one-liner stays bounded (no chain walk).
 */
function describeShallow(cause: unknown): string {
    if (cause instanceof Error) return errorHeadline(cause);
    return describeNonError(cause);
}

/** The non-`Error` branch of {@link describeCause}: string, discriminated object, primitive, or JSON. */
function describeNonError(cause: unknown): string {
    if (typeof cause === "string") return cause;
    if (cause === null || typeof cause !== "object") return String(cause);
    // A discriminated domain error `{ type, ... }`. Prefer a human `message` field (ProviderError et
    // al.) after the discriminant so the line names both the KIND of failure and its reason.
    // `type`/`message` are read structurally off an opaque object, hence the narrow cast.
    const record = cause as { type?: unknown; message?: unknown };
    if (typeof record.type === "string") {
        return typeof record.message === "string" && record.message.length > 0 ? `${record.type}: ${record.message}` : record.type;
    }
    const json = safeStringify(cause);
    return json.length > MAX_ONE_LINE_JSON ? `${json.slice(0, MAX_ONE_LINE_JSON)}…` : json;
}

/**
 * The full multi-line rendering of a failure value for a details view (no ANSI — plain strings):
 * - an `Error` → `name: message`, then its stack frames, then an indented, recursively-rendered
 *   `caused by:` section for one level of `.cause` (bounded by {@link MAX_CAUSE_DEPTH});
 * - a string → its own lines (split on newlines);
 * - any other primitive → a single `String(cause)` line;
 * - any other object → a pretty-printed, circular-safe JSON dump (2-space indent), one array entry
 *   per line.
 *
 * The whole result is capped at {@link MAX_DETAIL_LINES} so a giant stack or object cannot flood the
 * dialog.
 */
export function causeDetailLines(cause: unknown): string[] {
    const lines: string[] = [];
    appendCauseDetail(cause, lines, 0);
    return lines.slice(0, MAX_DETAIL_LINES);
}

/** Accumulate {@link causeDetailLines} into `lines`, tracking `.cause` recursion `depth`. */
function appendCauseDetail(cause: unknown, lines: string[], depth: number): void {
    if (lines.length >= MAX_DETAIL_LINES) return;

    if (cause instanceof Error) {
        const headline = errorHeadline(cause);
        lines.push(headline);
        if (typeof cause.stack === "string") {
            // The V8 stack repeats the headline as its first line; skip that one duplicate and keep
            // the frames. Other engines may not repeat it — the trim-compare tolerates both.
            for (const frame of cause.stack.split("\n")) {
                if (frame.trim() === headline.trim()) continue;
                lines.push(frame);
            }
        }
        const inner = cause.cause;
        if (inner !== undefined && inner !== null && depth < MAX_CAUSE_DEPTH) {
            lines.push("");
            lines.push("caused by:");
            const start = lines.length;
            appendCauseDetail(inner, lines, depth + 1);
            // Indent the whole nested section so the cause chain reads as a tree, not a flat list.
            for (let i = start; i < lines.length; i++) lines[i] = `  ${lines[i]}`;
        }
        return;
    }

    if (typeof cause === "string") {
        for (const line of cause.split("\n")) lines.push(line);
        return;
    }
    if (cause === null || typeof cause !== "object") {
        lines.push(String(cause));
        return;
    }
    for (const line of safeStringify(cause, 2).split("\n")) lines.push(line);
}

/**
 * `JSON.stringify` that never throws on a circular reference (a `[Circular]` placeholder replaces a
 * repeat visit) and degrades to `String(value)` on any other serialization fault (a BigInt, a
 * throwing getter). `space` selects one-line vs pretty output. A shared DAG node seen twice is
 * flagged `[Circular]` too — an acceptable fidelity trade for an error dump, since the replacer has
 * no exit hook to un-see a node on the way back up.
 */
function safeStringify(value: unknown, space?: number): string {
    const seen = new WeakSet<object>();
    try {
        // `val` is every nested value the serializer visits — genuinely `unknown`.
        const json = JSON.stringify(
            value,
            (_key, val: unknown): unknown => {
                if (typeof val === "object" && val !== null) {
                    if (seen.has(val)) return "[Circular]";
                    seen.add(val);
                }
                return val;
            },
            space,
        );
        return json ?? String(value);
    } catch {
        return String(value);
    }
}
