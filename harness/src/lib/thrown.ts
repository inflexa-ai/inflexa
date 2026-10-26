/**
 * The reads over an arbitrary thrown value at a catch site: is it already an
 * `Error`, and which of its `message` / `name` fields carry text. Every read
 * but {@link errorOf} is structural, so a thrown value from another module
 * realm — where `instanceof` against this build's class reference would miss —
 * answers too.
 */

/**
 * The exact `Error` passthrough. A thrown value that IS an `Error` comes back
 * as itself (class, `.cause`, and own fields intact); anything else gives
 * `undefined`. The class check is deliberate: a structural lookalike must not
 * pass, because each caller rethrows or forwards the value as an `Error`.
 */
export function errorOf(value: unknown): Error | undefined {
    return value instanceof Error ? value : undefined;
}

/** The thrown value's own `message` text, when it carries one. */
export function errorMessageOf(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null || !("message" in value)) return undefined;
    const { message } = value;
    return typeof message === "string" ? message : undefined;
}

/** The thrown value's own `name`, when it carries one. */
export function errorNameOf(value: unknown): string | undefined {
    if (typeof value !== "object" || value === null || !("name" in value)) return undefined;
    const { name } = value;
    return typeof name === "string" ? name : undefined;
}
