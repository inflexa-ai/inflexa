/**
 * Diagnosis and repair of model-authored arguments that failed Zod validation.
 *
 * A Zod issue message is accurate but inert: "Invalid input: expected object,
 * received string" tells a model what the schema wanted, not what it did wrong
 * or how to change the next call. Two failure modes put a whole, well-formed
 * JSON value behind that message:
 *
 *  - **Double encoding** — the model serialized a nested object or array with
 *    `JSON.stringify` and passed the resulting string as the argument value.
 *  - **Wrapper artifacts** — the JSON value arrived intact but with function-call
 *    markup or a markdown fence stuck to it (`{…}</parameter>\n</invoke>`,
 *    ` ```json {…}``` `). The payload is complete; only the wrapper makes it a
 *    string.
 *
 * This module owns both halves of the response for the four model-facing
 * validation sites (`loop/run-agent.ts`'s tool-input boundary,
 * `execution/run-synthesis.ts`, `tools/research/generate-plan.ts`,
 * `tools/iterate-report.ts`):
 *
 *  - `hintForZodIssue` — a **diagnostic only**. It parses nothing into the
 *    caller's data; it distinguishes the two modes so the message the model
 *    reads matches the mistake it actually made. When neither mode explains the
 *    string it stays silent, because speculative advice to a model that is
 *    already misdiagnosing is worse than no advice at all.
 *  - `repairToolInput` — an **issue-guided** repair: only a path where the
 *    schema wanted an `object` or `array` and found a string is even considered,
 *    so a tool that legitimately declares a `z.string()` field is never touched.
 *    It makes validation *reachable*; it never substitutes for it. The caller
 *    re-runs the full schema over the repaired value, and the tool's own
 *    semantic checks still run unchanged.
 *
 * Neither is used by `tools/lib/api-utils.ts`'s `summarizeZodIssues`, whose
 * audience is a developer reading a log about a third-party API response shape —
 * "pass the object directly" is meaningless advice for a payload no one here
 * constructed.
 *
 * Detection walks `issue.path` into the raw input rather than reading the
 * received type off the issue. Zod 4's `invalid_type` issue exposes `expected`
 * but carries no `received` field — the received type appears only inside the
 * human-readable `message`, which is version- and locale-dependent and must
 * not be pattern-matched.
 */

import type { z } from "zod";

/**
 * Strings longer than this are neither parsed nor repaired. A real argument
 * payload is tens of kilobytes; the ceiling exists so a pathological input
 * cannot turn a failed validation into an expensive parse.
 */
const MAX_REPAIRABLE_STRING_LENGTH = 1_000_000;

/** Longest run of offending wrapper text quoted back to the model in a hint. */
const HINT_SNIPPET_LENGTH = 40;

/** A trailing `</parameter>`, optionally followed by `</invoke>`. */
const TRAILING_CALL_TAGS = /<\/parameter>\s*(?:<\/invoke>\s*)?$/;

/**
 * A hint for a single Zod issue, or `undefined` when nothing actionable can be
 * said. `input` is the raw value that failed validation — the same value handed
 * to `safeParse` — because the issue alone does not carry the offending value.
 *
 * Fires only for an `invalid_type` issue wanting an `object` or an `array` whose
 * path resolves to a string, and only when that string demonstrably *is* the
 * expected value:
 *
 *  1. it parses in full as JSON of the expected type → double encoding, and
 *  2. it parses only once a wrapper artifact is stripped → the value is intact
 *     but surrounded by content that does not belong.
 *
 * Anything else — a plain string, a truncated fragment, a stray
 * `<parameter name=…>` opener — yields `undefined`.
 *
 * A path that does not resolve — a mismatched shape, a pruned branch — yields
 * `undefined` rather than throwing.
 */
export function hintForZodIssue(issue: z.core.$ZodIssue, input: unknown): string | undefined {
    const expected = repairableExpectation(issue);
    if (expected === undefined) return undefined;

    const value = resolvePath(input, issue.path);
    if (typeof value !== "string" || value.length > MAX_REPAIRABLE_STRING_LENGTH) return undefined;

    if (parseAs(value, expected) !== undefined) {
        return `This argument arrived as a JSON-encoded string. Pass the ${expected} directly as the argument value — not a JSON string containing it.`;
    }

    const { text, removed } = stripWrappers(value);
    if (removed !== "" && parseAs(text, expected) !== undefined) {
        return `This argument arrived with extra content wrapped around the JSON ${expected} (${quoteSnippet(removed)}). Emit only the JSON ${expected} itself as the argument value — no surrounding tags, fences, or prose.`;
    }

    return undefined;
}

/**
 * Repair model-authored tool input whose JSON values arrived as strings behind a
 * wrapper artifact, or double-encoded. Returns a **new** input value with the
 * repairs applied, or `undefined` when nothing was repaired.
 *
 * The repair is guided entirely by `error`: a path is considered only when the
 * schema reported an `invalid_type` there wanting an `object` or `array` and the
 * value sitting at that path is a string. The parsed result is accepted only if
 * its own type matches what the schema expected, so a string field that happens
 * to hold JSON-looking text is never rewritten.
 *
 * The input object graph is never mutated: the repaired copy shares every
 * untouched branch and clones only along the paths it patches. Repaired content
 * is not re-examined — one pass, no recursion — and no input causes a throw.
 */
export function repairToolInput(input: unknown, error: z.ZodError): unknown | undefined {
    try {
        let repaired: unknown = input;
        let didRepair = false;

        for (const issue of error.issues) {
            const expected = repairableExpectation(issue);
            if (expected === undefined) continue;

            const value = resolvePath(repaired, issue.path);
            if (typeof value !== "string" || value.length > MAX_REPAIRABLE_STRING_LENGTH) continue;

            const parsed = parseAs(value, expected) ?? parseAs(stripWrappers(value).text, expected);
            if (parsed === undefined) continue;

            repaired = setAtPath(repaired, issue.path, parsed.value);
            didRepair = true;
        }

        return didRepair ? repaired : undefined;
    } catch {
        return undefined;
    }
}

/** The `object`/`array` expectation of an `invalid_type` issue, if it has one. */
function repairableExpectation(issue: z.core.$ZodIssue): "object" | "array" | undefined {
    if (issue.code !== "invalid_type") return undefined;
    if (issue.expected === "object") return "object";
    if (issue.expected === "array") return "array";
    return undefined;
}

/**
 * Parse `raw` as JSON and accept it only when the result's own type matches
 * `expected`. Boxed in a `{ value }` cell so a legitimately parsed `null` or
 * `undefined` stays distinguishable from "did not parse" — a `null` never
 * matches either expectation, but the cell keeps the caller's checks honest.
 */
function parseAs(raw: string, expected: "object" | "array"): { readonly value: unknown } | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (expected === "array") return Array.isArray(parsed) ? { value: parsed } : undefined;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { value: parsed } : undefined;
}

/**
 * Strip the wrapper artifacts a model sticks to an otherwise complete JSON
 * value: trailing function-call markup and a markdown code fence. `removed`
 * collects what came off, for the hint to quote back; it is empty when the
 * string carried no recognized wrapper.
 *
 * Deliberately narrow, mirroring `tools/research/generate-analogy-report.ts`'s
 * `stripFence`: these two shapes and nothing else. Beyond that, no salvaging —
 * a fragment with a *leading* `<parameter name=…>` opener is not a whole value
 * with decoration on it, and pretending otherwise would invent content.
 */
function stripWrappers(raw: string): { readonly text: string; readonly removed: string } {
    const removed: string[] = [];
    let text = raw.trim();

    const tags = TRAILING_CALL_TAGS.exec(text);
    if (tags !== null) {
        removed.push(tags[0].trim());
        text = text.slice(0, tags.index).trim();
    }

    if (text.startsWith("```")) {
        const open = /^```(?:json)?\s*\n/i.exec(text);
        if (open !== null) {
            removed.push(open[0].trim());
            text = text.slice(open[0].length);
        }
        const close = /\n```\s*$/.exec(text);
        if (close !== null) {
            removed.push("```");
            text = text.slice(0, close.index);
        }
    }

    return { text: text.trim(), removed: removed.join(" ") };
}

/** Quote wrapper text back to the model, bounded so a hint stays a hint. */
function quoteSnippet(removed: string): string {
    const snippet = removed.length > HINT_SNIPPET_LENGTH ? `${removed.slice(0, HINT_SNIPPET_LENGTH)}…` : removed;
    return `found: ${JSON.stringify(snippet)}`;
}

/**
 * Walk a Zod issue path into the raw input. Returns `undefined` for any key
 * that cannot be traversed, which is indistinguishable from a genuine
 * `undefined` at that path — acceptable here, since the caller only acts on a
 * resolved `string`.
 */
function resolvePath(input: unknown, path: readonly PropertyKey[]): unknown {
    let current: unknown = input;
    for (const key of path) {
        if (current === null || (typeof current !== "object" && typeof current !== "function")) {
            return undefined;
        }
        current = (current as Record<PropertyKey, unknown>)[key];
    }
    return current;
}

/**
 * Return a copy of `root` with `value` at `path`, cloning only the containers
 * along that path and sharing every other branch. `root` is left untouched.
 */
function setAtPath(root: unknown, path: readonly PropertyKey[], value: unknown): unknown {
    if (path.length === 0) return value;

    const [key, ...rest] = path;
    if (root === null || typeof root !== "object") return root;

    const container = root as Record<PropertyKey, unknown>;
    const child = setAtPath(container[key!], rest, value);
    if (Array.isArray(root)) {
        const copy = [...root];
        copy[key as number] = child;
        return copy;
    }
    return { ...container, [key!]: child };
}
