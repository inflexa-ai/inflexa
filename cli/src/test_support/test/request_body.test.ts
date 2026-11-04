import { describe, expect, test } from "bun:test";

import { requestBodyText, requestedModel } from "../request_body.ts";

describe("requestBodyText", () => {
    test("gives a string body as itself", () => {
        expect(requestBodyText({ body: '{"a":1}' })).toBe('{"a":1}');
    });

    test("gives a URLSearchParams body as its form encoding", () => {
        expect(requestBodyText({ body: new URLSearchParams({ a: "1", b: "x y" }) })).toBe("a=1&b=x+y");
    });

    test("throws for a missing body", () => {
        expect(() => requestBodyText(undefined)).toThrow("the request has no body");
        expect(() => requestBodyText({ body: null })).toThrow("the request has no body");
    });

    test("throws for a body of another form", () => {
        expect(() => requestBodyText({ body: new Blob(["x"]) })).toThrow("neither a string nor a URLSearchParams");
    });
});

describe("requestedModel", () => {
    test("gives the model of a JSON body", () => {
        expect(requestedModel({ body: JSON.stringify({ model: "gpt-4o", stream: false }) })).toBe("gpt-4o");
    });

    test("fails for a body without a string model", () => {
        expect(() => requestedModel({ body: JSON.stringify({ model: 7 }) })).toThrow();
    });

    test("fails for a missing body", () => {
        expect(() => requestedModel(undefined)).toThrow("the request has no body");
    });
});
