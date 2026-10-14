/**
 * The loud guard of a test's own setup: fails with the name of the missing
 * piece instead of a `TypeError: cannot read properties of undefined` three
 * lines later.
 */
export function must<T>(value: T, what: string): NonNullable<T> {
    if (value === undefined || value === null) throw new Error(`expected ${what}, but it is ${value === null ? "null" : "undefined"}`);
    // SAFETY: the branch above returns for `undefined` and `null`, so this cast
    // only removes the two members the check has excluded.
    return value;
}
