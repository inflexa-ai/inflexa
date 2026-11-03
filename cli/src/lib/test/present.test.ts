import { describe, expect, test } from "bun:test";

import { present } from "../present.ts";

describe("present", () => {
    test("gives a present value as it is", () => {
        const value = { id: 1 };
        expect(present(value)).toBe(value);
    });

    test("gives a falsy value that is not null or undefined", () => {
        expect(present(0)).toBe(0);
        expect(present("")).toBe("");
        expect(present(false)).toBe(false);
    });

    test("throws for null with the description in the message", () => {
        expect(() => present(null, "the first row")).toThrow("the first row is absent");
    });

    test("throws for undefined with the description in the message", () => {
        const rows: string[] = [];
        expect(() => present(rows[0], "the first row")).toThrow("the first row is absent");
    });

    test("names the value when no description is given", () => {
        expect(() => present(undefined)).toThrow("the value is absent");
    });

    test("throws an Error", () => {
        expect(() => present(null)).toThrow(Error);
    });
});
