import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { parsedJson } from "../json.ts";

describe("parsedJson", () => {
    const schema = z.object({ a: z.number() });

    test("gives the value that the schema proved", () => {
        expect(parsedJson('{"a":1}', schema)).toEqual({ a: 1 });
    });

    test("gives the whole value for z.unknown()", () => {
        expect(parsedJson('{"a":[1,"x",null]}', z.unknown())).toEqual({ a: [1, "x", null] });
    });

    test("throws an Error with the parse message for a malformed text", () => {
        expect(() => parsedJson("{not json", schema)).toThrow("malformed JSON: SyntaxError");
    });

    test("throws the ZodError for a mismatch", () => {
        expect(() => parsedJson('{"a":"x"}', schema)).toThrow(z.ZodError);
    });
});
