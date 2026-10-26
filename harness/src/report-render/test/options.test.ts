import { describe, expect, it } from "bun:test";

import { pageCall } from "./options.js";

describe("pageCall", () => {
    it("runs the page source again for each call, so each call sees new page globals", () => {
        const next = pageCall("var count = 0; function next() { count += 1; return count; }", "next");

        expect(next()).toBe(1);
        expect(next()).toBe(1);
    });

    it("passes the arguments to the page function", () => {
        const add = pageCall("function add(a, b) { return a + b; }", "add");

        expect(add(2, 3)).toBe(5);
    });

    it("fails when the page source holds no function of that name", () => {
        const other = pageCall("var other = 1;", "other");

        expect(() => other()).toThrow("the page source holds no other");
    });
});
