import { describe, expect, it } from "bun:test";

import { stripHtmlTags } from "../html-text.js";

describe("stripHtmlTags", () => {
    it("strips each tag run to the first closing bracket", () => {
        expect(stripHtmlTags("<b>bold</b> and <i>it</i>")).toBe("bold and it");
    });

    it("takes a chain of nested opens from the first bracket to the first close", () => {
        expect(stripHtmlTags("<a<b<c>d>")).toBe("d>");
        expect(stripHtmlTags("<<em>x</em>>")).toBe("x>");
    });

    it("keeps text with an angle bracket but no tag span as it is", () => {
        expect(stripHtmlTags("3 > 2 but no opener")).toBe("3 > 2 but no opener");
    });
});
