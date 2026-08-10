/**
 * The assert rules of the value tier. A resolver reads a fresh value, and these functions match it
 * against the authored belief.
 *
 * Each realization of the resolver calls these functions. Thus one semantics exists, and the fixture
 * stays the executable specification of the value tier.
 */

import type { Reference, UnresolvedReference } from "../contracts/report-reference.js";

/**
 * The relative epsilon of a value match with no authored tolerance.
 *
 * Float arithmetic shifts a computed value in its last bits. For example, `0.3 - 0.1` gives
 * 0.19999999999999998, and exact equality would report that noise as a fabrication.
 *
 * The epsilon absorbs the noise and nothing else. It is far below the difference that a rounded figure
 * makes, thus an author who writes 0.05 against a true 0.0499 still fails. An author who wants a rounded
 * figure to pass states a `tolerance`, which is the one place where the intent belongs.
 */
const RELATIVE_EPSILON = 1e-9;

/**
 * Read an authored value or a resolved cell as a finite number.
 *
 * A text-backed artifact such as a CSV holds every cell as a string, thus a numeric column arrives as
 * `"0.01"` and not as `0.01`. A comparison that respects the JavaScript type would fail an author who
 * states the number, and the arithmetic of a derivation could never run over a real CSV.
 *
 * The parse reads the whole string, thus `"12 genes"` stays text and never reads as 12. `Number` accepts
 * the exponent form that a p-value uses, for example `"1.2e-45"`. A blank string is not a number, because
 * `Number("")` gives 0 and an empty cell must never read as zero.
 */
export function asFiniteNumber(value: string | number): number | undefined {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

/** Name a value with its type, so that a failed match never reads as two identical values. */
function describeValue(value: string | number): string {
    return typeof value === "string" ? `the string ${JSON.stringify(value)}` : `the number ${value}`;
}

/**
 * Match a resolved value against an authored one.
 *
 * The comparison is numeric whenever both sides read as a finite number, thus the CSV cell `"0.01"`
 * matches the number 0.01 that an author states. An authored tolerance is an absolute difference, and it
 * is the author's own statement of how close is close enough. With no tolerance the comparison is
 * relative, because an exact match would fail on the float noise of a computed value. Any other pair
 * matches on exact equality.
 */
export function valuesMatch(expected: string | number, actual: string | number, tolerance: number | undefined): boolean {
    const expectedNumber = asFiniteNumber(expected);
    const actualNumber = asFiniteNumber(actual);
    if (expectedNumber !== undefined && actualNumber !== undefined) {
        if (tolerance !== undefined) {
            return Math.abs(expectedNumber - actualNumber) <= tolerance;
        }
        return Math.abs(expectedNumber - actualNumber) <= RELATIVE_EPSILON * Math.max(1, Math.abs(expectedNumber), Math.abs(actualNumber));
    }
    return expected === actual;
}

/** Match a resolved scalar against the authored value, under the authored tolerance. */
export function checkValueAssertion(
    reference: Reference,
    expected: string | number | undefined,
    tolerance: number | undefined,
    resolved: string | number,
): UnresolvedReference | undefined {
    if (expected === undefined || valuesMatch(expected, resolved, tolerance)) {
        return undefined;
    }
    return { reference, reason: "assertion-failed", detail: `expected ${describeValue(expected)} but resolved ${describeValue(resolved)}` };
}

/** Match the resolved citation key against the authored value. The key carries its `idKind:` prefix. */
export function checkCitationAssertion(reference: Reference, expected: string | undefined, resolved: string): UnresolvedReference | undefined {
    if (expected === undefined || expected === resolved) {
        return undefined;
    }
    return { reference, reason: "assertion-failed", detail: `expected ${String(expected)} but resolved citation ${resolved}` };
}
