// The single answer to "what failed" for an unknown thrown / `err` value. Both the cli and the
// harness move failures around as discriminated objects (`{ type, ... }`, e.g. a harness
// `ProviderError` `{ type, retryable, message, cause }`) as well as plain `Error`s, and a naive
// `String(cause)` collapses every structured error to the useless `[object Object]`. This module is
// the one place that knows how to render either shape — a bounded one-liner for a banner/log
// summary ({@link describeCause}) and a full multi-line dump for a details view
// ({@link causeDetailLines}). It mirrors the spirit of the harness's `ResultError.describe`
// (harness/src/lib/result.ts) but adds the `type` discriminant and a bounded `.cause` tail.

/** Longest one-line rendering of a value's interior (JSON fallback, aggregate summary) — a banner is one line. */
const MAX_ONE_LINE_JSON = 200;
/** Cap the details dump so a pathological object/stack can never flood the dialog. */
const MAX_DETAIL_LINES = 400;
/** Stop walking `Error.cause` / `AggregateError.errors` after this depth so a self-referential chain cannot loop forever. */
const MAX_CAUSE_DEPTH = 5;
/** How many of an `AggregateError`'s sub-errors the ONE-LINE summary names before it elides the rest. */
const MAX_ONE_LINE_AGGREGATE = 3;
/** How many links of a `.cause` chain {@link chainCarriesCode} reads before it gives up. */
const MAX_ERRNO_LINKS = 5;

/**
 * Render an unknown failure value as ONE human line for a banner or a log summary. Never
 * `String(object)`. The cases, in order:
 * - an `AggregateError` → `name: message`, then a bounded summary of its sub-errors;
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
        // Sub-errors win over `.cause` when both are present: an AggregateError's own message names
        // the aggregation ("All promises were rejected"), never the failure, so `.errors` is where
        // every fact a reader needs actually lives.
        const aggregated = aggregateErrors(cause);
        if (aggregated) return `${head} (${truncateOneLine(summarizeAggregate(aggregated))})`;

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

/**
 * The message of a failure value, with no `name:` prefix and no `.cause` tail: an `Error` gives its
 * `message`, and any other value gives its {@link describeCause} rendering (a string as itself, a
 * `{ type, message }` object as `type: message`, other objects as bounded JSON). Use it where the
 * text follows a sentence of the caller; use {@link describeCause} where the line stands alone.
 */
export function messageOf(cause: unknown): string {
    return cause instanceof Error ? cause.message : describeNonError(cause);
}

/**
 * The value itself when it is an `Error`, else `undefined`. The check is the class check, so a
 * structural lookalike does not pass. A catch site that reads a field of an `Error` reads through
 * this, and keeps its fallback for every other value.
 */
export function errorOf(cause: unknown): Error | undefined {
    return cause instanceof Error ? cause : undefined;
}

/**
 * Whether a failure value, or a value that it wraps through `.cause`, carries the errno `code`.
 * The walk reads at most {@link MAX_ERRNO_LINKS} links, outermost first, so a self-referential
 * chain ends. A link is read structurally: a wrapper is not always an `Error`.
 */
export function chainCarriesCode(cause: unknown, code: string): boolean {
    let current = cause;
    for (let depth = 0; depth < MAX_ERRNO_LINKS && current !== null && current !== undefined; depth += 1) {
        if (typeof current === "object" && "code" in current && current.code === code) return true;
        current = typeof current === "object" && "cause" in current ? current.cause : undefined;
    }
    return false;
}

/**
 * The sub-errors of an `AggregateError`, or `null` for every other value (including an empty one,
 * which carries no more information than its headline).
 *
 * This is not an exotic shape: a failed `fetch` throws one under Bun/undici, so it is what the proxy
 * reachability check sees. `Array.isArray` guards the read because the constructor accepts ANY
 * iterable — `new AggregateError(someSet)` is legal, and only a spec-conformant engine normalizes it.
 */
function aggregateErrors(cause: unknown): unknown[] | null {
    if (!(cause instanceof AggregateError)) return null;
    const errors: unknown = cause.errors;
    if (!Array.isArray(errors) || errors.length === 0) return null;
    const members: unknown[] = errors;
    return members;
}

/** `N errors: a; b; c; +M more` — the one-line, shallow (non-recursing) view of an aggregate's members. */
function summarizeAggregate(errors: unknown[]): string {
    const shown = errors.slice(0, MAX_ONE_LINE_AGGREGATE);
    const elided = errors.length - shown.length;
    const body = shown.map(describeShallow).join("; ");
    const count = `${errors.length} error${errors.length === 1 ? "" : "s"}`;
    return elided > 0 ? `${count}: ${body}; +${elided} more` : `${count}: ${body}`;
}

/** Clamp a one-line rendering so a banner stays one line. */
function truncateOneLine(text: string): string {
    return text.length > MAX_ONE_LINE_JSON ? `${text.slice(0, MAX_ONE_LINE_JSON)}…` : text;
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
    if (typeof cause !== "object" || cause === null) return describePrimitive(cause);
    // A discriminated domain error `{ type, ... }`. Prefer a human `message` field (ProviderError et
    // al.) after the discriminant so the line names both the KIND of failure and its reason.
    // `type`/`message` are read structurally off an opaque object.
    const record: { type?: unknown; message?: unknown } = cause;
    if (typeof record.type === "string") {
        return typeof record.message === "string" && record.message.length > 0 ? `${record.type}: ${record.message}` : record.type;
    }
    return truncateOneLine(safeStringify(cause));
}

/**
 * The text of a value that is not a non-null object, the same text `String(value)` gives. Each kind
 * is a typed branch, so no conversion of an `unknown` value is left. The caller reads an object
 * itself, and the `object` branch gives the bounded JSON only to keep the switch total.
 */
function describePrimitive(value: unknown): string {
    switch (typeof value) {
        case "string":
            return value;
        case "undefined":
            return "undefined";
        case "number":
            return `${value}`;
        case "bigint":
            return value.toString();
        case "boolean":
            return value ? "true" : "false";
        case "symbol":
            return value.toString();
        case "function":
            return value.toString();
        case "object":
            return value === null ? "null" : safeStringify(value);
    }
}

/**
 * Locate a harness provider `auth` failure anywhere on a cause chain. The match is STRUCTURAL — the
 * exact `ProviderError` auth shape (`type: "auth"`, `retryable: false`, a string `message`) rather
 * than an imported harness type or provider message text — so it finds the value under any wrapping
 * (a `ResultError`'s cause, the AI SDK's `AI_APICallError`, an `AggregateError` member) and never
 * couples the cli's rendering to wire strings a third-party proxy authors. The `retryable: false`
 * leg is what keeps a coincidental `{ type: "auth" }` from some other domain union from matching.
 * Depth-bounded like {@link causeDetailLines} so a self-referential chain cannot loop.
 */
export function findAuthCause(cause: unknown, depth = 0): { message: string } | null {
    if (depth > MAX_CAUSE_DEPTH || cause === null || typeof cause !== "object") return null;
    const record: { type?: unknown; retryable?: unknown; message?: unknown; cause?: unknown } = cause;
    if (record.type === "auth" && record.retryable === false && typeof record.message === "string") return { message: record.message };
    const aggregated = aggregateErrors(cause);
    if (aggregated) {
        for (const sub of aggregated) {
            const hit = findAuthCause(sub, depth + 1);
            if (hit) return hit;
        }
    }
    return findAuthCause(record.cause, depth + 1);
}

/**
 * The full multi-line rendering of a failure value for a details view (no ANSI — plain strings):
 * - an `Error` → `name: message`, then its stack frames, then an indented, recursively-rendered
 *   `caused by:` section for one level of `.cause` (bounded by {@link MAX_CAUSE_DEPTH});
 * - an `AggregateError` → the above, plus an indented `errors[i]:` section per sub-error, rendered
 *   BEFORE `caused by:` (the sub-errors are the failure; `.cause`, if any, is context around it);
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
        const aggregated = aggregateErrors(cause);
        if (aggregated && depth < MAX_CAUSE_DEPTH) {
            for (const [index, sub] of aggregated.entries()) {
                // Re-checked per sub-error, not once: a single fat member can exhaust the budget, and
                // the trailing `slice` would then throw away work we had already paid to render.
                if (lines.length >= MAX_DETAIL_LINES) return;
                lines.push("");
                lines.push(`errors[${index}]:`);
                indentFrom(lines, lines.length, () => appendCauseDetail(sub, lines, depth + 1));
            }
        }

        const inner = cause.cause;
        if (inner !== undefined && inner !== null && depth < MAX_CAUSE_DEPTH) {
            lines.push("");
            lines.push("caused by:");
            indentFrom(lines, lines.length, () => appendCauseDetail(inner, lines, depth + 1));
        }
        return;
    }

    if (typeof cause === "string") {
        for (const line of cause.split("\n")) lines.push(line);
        return;
    }
    if (cause === null || typeof cause !== "object") {
        lines.push(describePrimitive(cause));
        return;
    }
    for (const line of safeStringify(cause, 2).split("\n")) lines.push(line);
}

/**
 * Run `emit`, then indent every line it appended from `start` onward, so a nested section reads as a
 * tree rather than a flat list. The callback shape keeps the "where did this section begin" bookkeeping
 * in one place — the two nesting sites (`errors[i]:`, `caused by:`) got it subtly different otherwise.
 */
function indentFrom(lines: string[], start: number, emit: () => void): void {
    emit();
    for (const [offset, line] of lines.slice(start).entries()) lines[start + offset] = `  ${line}`;
}

/**
 * `JSON.stringify` that never throws on a circular reference (a `[Circular]` placeholder replaces a
 * repeat visit) and degrades to `String(value)` on any other serialization fault (a BigInt, a
 * throwing getter). `space` selects one-line vs pretty output. A shared DAG node seen twice is
 * flagged `[Circular]` too — an acceptable fidelity trade for an error dump, since the replacer has
 * no exit hook to un-see a node on the way back up.
 */
function safeStringify(value: unknown, space?: number): string {
    try {
        // oxlint-disable-next-line typescript/no-base-to-string -- the value has no JSON form (a function, a symbol, `undefined`), and `String` is the only rendering left for it
        return stringifyOnce(value, space) ?? String(value);
    } catch {
        // oxlint-disable-next-line typescript/no-base-to-string -- `JSON.stringify` threw (a BigInt, a throwing getter), and `String` is the only rendering left for the value
        return String(value);
    }
}

/** `JSON.stringify` gives `undefined` for a function, a symbol, or `undefined`, which its declared type does not show. */
function stringifyOnce(value: unknown, space: number | undefined): string | undefined {
    const seen = new WeakSet<object>();
    // `val` is every nested value the serializer visits — genuinely `unknown`.
    return JSON.stringify(
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
}
