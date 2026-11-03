import { describe, expect, test } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";

import { awaitOk } from "../result.ts";

async function rejection(call: Promise<unknown>): Promise<Error> {
    try {
        await call;
    } catch (thrown) {
        expect(thrown).toBeInstanceOf(Error);
        if (thrown instanceof Error) return thrown;
    }
    throw new Error("the call did not reject with an Error");
}

describe("awaitOk", () => {
    test("gives the ok value of a Result", async () => {
        expect(await awaitOk(ok(1))).toBe(1);
    });

    test("gives the ok value of a Promise of a Result", async () => {
        expect(await awaitOk(Promise.resolve().then(() => ok("a")))).toBe("a");
    });

    test("gives the ok value of a ResultAsync", async () => {
        expect(await awaitOk(okAsync({ id: 2 }))).toEqual({ id: 2 });
    });

    test("rejects with an Error whose cause is the err value and whose message names the err", async () => {
        const failure = { type: "boom", message: "it broke" };
        const thrown = await rejection(awaitOk(err(failure)));
        expect(thrown.message).toBe("the call gave an err: boom: it broke");
        expect(thrown.cause).toBe(failure);
    });

    test("rejects the same way for a Promise of a Result and for a ResultAsync", async () => {
        const first = { type: "first" };
        const second = { type: "second" };
        expect((await rejection(awaitOk(Promise.resolve().then(() => err(first))))).cause).toBe(first);
        expect((await rejection(awaitOk(errAsync(second)))).cause).toBe(second);
    });
});
