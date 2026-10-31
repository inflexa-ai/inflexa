import { describe, expect, it } from "bun:test";

import { makeToolCallValue } from "../../loop/tool-value.js";
import { viewCode, viewFields, viewJson, viewText } from "../tool-view.js";

function shown(output: unknown) {
    return makeToolCallValue(output).unwrapOr(undefined);
}

describe("the view helpers", () => {
    it("gives the JSON text of a string with its quotes", () => {
        expect(shown(viewJson("a"))).toEqual({ kind: "json", text: '"a"', cut: false });
    });

    it("gives a kind only for a helper object, never for a plain object with a field kind", () => {
        const plain = { kind: "text", text: "a", cut: false };
        expect(shown(plain)).toEqual({ kind: "json", text: JSON.stringify(plain), cut: false });
        expect(shown(viewText("a"))).toEqual({ kind: "text", text: "a", cut: false });
    });

    it("leaves out a field whose leaf is undefined", () => {
        const fields = viewFields({ a: viewText("1"), b: undefined, c: viewCode("r", "x <- 1") });
        expect(fields.fields.map((field) => field.name)).toEqual(["a", "c"]);
    });
});
