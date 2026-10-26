import { describe, expect, it } from "bun:test";
import { err, errAsync, ok, okAsync } from "neverthrow";

import { errorOf } from "../thrown.js";
import { awaitOk } from "./result-assert.js";

describe("awaitOk", () => {
    it("gives the value of an ok, sync or async", async () => {
        expect(await awaitOk(ok(1))).toBe(1);
        expect(await awaitOk(okAsync(3))).toBe(3);
    });

    it("throws an Error whose cause is the err value", async () => {
        const failure = { tag: "boom" };
        const thrown: unknown = await awaitOk(err(failure)).catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(errorOf(thrown)?.cause).toBe(failure);
        expect(errorOf(thrown)?.message).toContain("boom");
    });

    it("throws the same Error for an async err", async () => {
        const failure = new Error("inner");
        const thrown: unknown = await awaitOk(errAsync(failure)).catch((error: unknown) => error);

        expect(thrown).toBeInstanceOf(Error);
        expect(errorOf(thrown)?.cause).toBe(failure);
    });
});
