/**
 * Shared Result assertion helper for the test files of several module families.
 * The helper serves a guaranteed ok: a test that expects an err states it with
 * `_unsafeUnwrapErr` directly.
 */

import type { Result, ResultAsync } from "neverthrow";

import { textOf } from "../unknown-text.js";

/**
 * Awaits a `Result`-bearing call and unwraps the ok, so the call states that it
 * succeeded. An err throws an `Error` with a stack and the err value as its
 * `cause`, where `_unsafeUnwrap` throws a plain object with no stack.
 */
export async function awaitOk<T, E>(call: Result<T, E> | Promise<Result<T, E>> | ResultAsync<T, E>): Promise<T> {
    const result = await call;
    if (result.isErr()) throw new Error(`the call gave an err: ${textOf(result.error)}`, { cause: result.error });
    return result.value;
}
