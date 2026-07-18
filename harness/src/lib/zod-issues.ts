/**
 * Model-facing hints for Zod validation failures.
 *
 * A Zod issue message is accurate but inert: "Invalid input: expected object,
 * received string" tells a model what the schema wanted, not what it did wrong
 * or how to change the next call. The one failure mode where the diagnosis is
 * unambiguous — and where a model otherwise retries the identical malformed
 * payload — is **double encoding**: the model serialized a nested object or
 * array with `JSON.stringify` and passed the resulting string as the argument
 * value.
 *
 * This module owns that one hint, for the four model-facing validation sites
 * (`loop/run-agent.ts`'s tool-input boundary, `execution/run-synthesis.ts`,
 * `tools/research/generate-plan.ts`, `tools/iterate-report.ts`). It is a
 * **diagnostic only**: nothing here parses, coerces, or accepts the string —
 * a double-encoded payload still fails validation, it just fails with an
 * actionable message attached.
 *
 * It is deliberately NOT used by `tools/lib/api-utils.ts`'s
 * `summarizeZodIssues`, whose audience is a developer reading a log about a
 * third-party API response shape — "pass the object directly" is meaningless
 * advice for a payload no one here constructed.
 *
 * Detection walks `issue.path` into the raw input rather than reading the
 * received type off the issue. Zod 4's `invalid_type` issue exposes `expected`
 * but carries no `received` field — the received type appears only inside the
 * human-readable `message`, which is version- and locale-dependent and must
 * not be pattern-matched.
 */

import type { z } from "zod";

/**
 * A hint for a single Zod issue, or `undefined` when nothing actionable can be
 * said. `input` is the raw value that failed validation — the same value handed
 * to `safeParse` — because the issue alone does not carry the offending value.
 *
 * Fires only when all three hold:
 *  1. the issue is an `invalid_type` wanting an `object` or an `array`,
 *  2. the value actually sitting at `issue.path` is a string, and
 *  3. that string plausibly IS serialized JSON (trimmed, it opens with `{`/`[`).
 *
 * A path that does not resolve — a mismatched shape, a pruned branch — yields
 * `undefined` rather than throwing.
 */
export function hintForZodIssue(issue: z.core.$ZodIssue, input: unknown): string | undefined {
    if (issue.code !== "invalid_type") return undefined;
    if (issue.expected !== "object" && issue.expected !== "array") return undefined;

    const value = resolvePath(input, issue.path);
    if (typeof value !== "string") return undefined;

    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;

    return `This argument arrived as a JSON-encoded string. Pass the ${issue.expected} directly as the argument value — not a JSON string containing it.`;
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
