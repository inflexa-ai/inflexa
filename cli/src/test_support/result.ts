import type { Result, ResultAsync } from "neverthrow";

import { describeCause } from "../lib/cause.ts";

/**
 * Awaits a call that gives a `Result` and unwraps the ok, so the call states that it succeeded. An err throws
 * an `Error` with a stack and the err value as its `cause`, where `_unsafeUnwrap` throws a plain object with no
 * stack. A test that expects an err states it with `_unsafeUnwrapErr` and a matcher.
 */
export async function awaitOk<T, E>(call: Result<T, E> | Promise<Result<T, E>> | ResultAsync<T, E>): Promise<T> {
    const result = await call;
    if (result.isErr()) throw new Error(`the call gave an err: ${describeCause(result.error)}`, { cause: result.error });
    return result.value;
}
