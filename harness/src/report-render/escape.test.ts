import { describe, expect, it } from "bun:test";

import { escapeAttr, escapeHtml } from "./escape.js";

describe("escapeHtml", () => {
    it("keeps a script tag as text", () => {
        // The angle brackets escape, thus the browser reads the tag as text and never as an element.
        const escaped = escapeHtml("<script>alert(1)</script>");
        expect(escaped).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(escaped.includes("<")).toBe(false);
    });

    it("escapes an ampersand one time and does not detect an existing entity", () => {
        expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
        // The escape is single-pass. The helper escapes each source `&`, thus an already-escaped entity
        // gains a second escape. This pins the plain behavior.
        expect(escapeHtml("&amp;")).toBe("&amp;amp;");
    });
});

describe("escapeAttr", () => {
    it("keeps a double quote and a single quote as text", () => {
        const escaped = escapeAttr("a \"double\" and a 'single'");
        expect(escaped).toBe("a &quot;double&quot; and a &#39;single&#39;");
        expect(escaped.includes('"')).toBe(false);
        expect(escaped.includes("'")).toBe(false);
    });

    it("gives output that cannot close a double-quoted attribute", () => {
        const hostile = '" onautofocus="alert(1)';
        const value = escapeAttr(hostile);
        // The escaped value holds no raw double quote, thus it cannot terminate the attribute early.
        expect(value.includes('"')).toBe(false);
        const attribute = `<input value="${value}">`;
        // The only two double quotes are the delimiters of the attribute.
        expect(attribute.split('"').length - 1).toBe(2);
    });
});
