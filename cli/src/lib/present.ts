/**
 * Gives `value` when it is not `null` or `undefined`, and narrows its type. Otherwise it
 * throws an `Error` that names the read (`<what> is absent`), where a non-null assertion
 * would pass the absent value on.
 *
 * Use it for a read whose construction guarantees presence: an element after a length
 * check, a map entry that the same function just set, a parallel array of the same length.
 * A lookup that can miss takes the absence path of its module (a `Result` error, `null`,
 * or a skip), because a throw there turns a handled absence into a crash. Do not use it on
 * an element of a `(T | undefined)[]` whose `undefined` is a legitimate value. On a hot
 * path, pass a constant string as `what`, because a template literal allocates for each
 * call.
 */
export function present<T>(value: T | null | undefined, what: string = "the value"): T {
    if (value === null || value === undefined) throw new Error(`${what} is absent`);
    return value;
}
