/**
 * The one module that turns an arbitrary thrown value into a diagnostic.
 * `instanceof Error` checks are kept out of every catch block: a thrown value
 * is `unknown` by contract, and only this module decides how to read one.
 */

/** The message of a thrown value: the `Error` message when there is one, the string form otherwise. */
export function errorMessage(err: unknown): string {
    // oxlint-disable-next-line typescript/no-base-to-string -- the default string form of an arbitrary non-Error thrown value is this normalizer's specified fallback.
    return err instanceof Error ? err.message : String(err);
}

/** The name a thrown value carries when it is an `Error`; `undefined` for any other value. */
export function errorName(err: unknown): string | undefined {
    return err instanceof Error ? err.name : undefined;
}

/** The errno string a Node fs or network failure carries on `.code`; `undefined` for any other value. */
export function errnoCode(err: unknown): string | undefined {
    return isError(err) && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

/** Whether a thrown value is an `Error` at runtime; the one `instanceof Error` the package performs. */
export function isError(err: unknown): err is Error {
    // SAFETY: the predicate claims exactly the set the `instanceof` test accepts, and it must stay that way.
    return err instanceof Error;
}

/**
 * Whether a thrown value is the abort a caller's `AbortSignal` produced. The
 * platform delivers it as a `DOMException` (its own class, not an `Error`) and
 * normalized code as an `Error`; both carry the `AbortError` name.
 */
export function isAbortError(err: unknown): boolean {
    return (err instanceof DOMException || err instanceof Error) && err.name === "AbortError";
}

/** The reason a caller's `AbortSignal` carries; the standard `AbortError` when the platform left it empty. */
export function abortReason(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
