import { describe, expect, it } from "bun:test";

import { scriptJson } from "./script-json.js";

describe("scriptJson", () => {
    it("replaces every `<` with the `<` sequence", () => {
        // The replacement makes a `</script` sequence unrepresentable, thus a string cell cannot close
        // the element early.
        const json = scriptJson({ cell: "a</script>b", note: "x < y" });
        expect(json.includes("<")).toBe(false);
        expect(json).toContain("a\\u003c/script>b");
        expect(json).toContain("x \\u003c y");
    });

    it("keeps the JSON value identical", () => {
        // The browser reads `<` as `<`, thus the parsed value matches the source value.
        const value = { rows: [{ k: "a</script>b" }], count: 3 };
        const parsed = JSON.parse(scriptJson(value));
        expect(parsed).toEqual(value);
    });
});
