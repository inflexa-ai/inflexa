import { describe, expect, test } from "bun:test";

import { guiUrl } from "./poc_gui.ts";

describe("guiUrl", () => {
    test("names the page of the server on the loopback address, with the token in the fragment", () => {
        const token = "0123456789abcdef".repeat(4);
        expect(guiUrl(8436, token)).toBe(`http://127.0.0.1:8436/gui/#token=${token}`);
    });

    test("encodes a token character that the fragment cannot carry as it is", () => {
        expect(guiUrl(8436, "a b&c")).toBe("http://127.0.0.1:8436/gui/#token=a%20b%26c");
    });
});
