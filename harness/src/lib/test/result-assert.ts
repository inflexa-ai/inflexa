/**
 * Shared Result assertion helper for the test files of several module families.
 * The helper serves a guaranteed ok: a test that expects an err states it with
 * `_unsafeUnwrapErr` directly.
 */

import type { Result, ResultAsync } from "neverthrow";

/**
 * Awaits a `Result`-bearing call and unwraps the ok, so the call states that it
 * succeeded.
 */
export async function awaitOk<T, E>(call: Result<T, E> | Promise<Result<T, E>> | ResultAsync<T, E>): Promise<T> {
    return (await call)._unsafeUnwrap();
}
