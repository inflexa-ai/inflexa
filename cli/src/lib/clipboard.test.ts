import { describe, expect, test } from "bun:test";

import { nativeCopyCommand, osc52Sequence } from "./clipboard.ts";

// The two branchy, correctness-critical bits of the clipboard writer: the OSC 52 escape encoding
// (a wrong byte silently corrupts the terminal or sets garbage) and the platform→tool mapping.

describe("osc52Sequence", () => {
    const ESC = "\x1b";
    const BEL = "\x07";

    test("encodes the text as base64 inside the ESC]52;c;…BEL frame", () => {
        const seq = osc52Sequence("hi", false);
        expect(seq).toBe(`${ESC}]52;c;${Buffer.from("hi").toString("base64")}${BEL}`);
        // Decoding the base64 payload round-trips to the original text.
        const b64 = seq.slice(`${ESC}]52;c;`.length, -1);
        expect(Buffer.from(b64, "base64").toString()).toBe("hi");
    });

    test("wraps in tmux DCS passthrough only when multiplexed", () => {
        const plain = osc52Sequence("x", false);
        const wrapped = osc52Sequence("x", true);
        expect(wrapped).toBe(`${ESC}Ptmux;${ESC}${plain}${ESC}\\`);
        expect(plain.startsWith(`${ESC}Ptmux`)).toBe(false);
    });
});

describe("nativeCopyCommand", () => {
    test("maps each platform to its clipboard tool", () => {
        expect(nativeCopyCommand("darwin", false)).toEqual(["pbcopy"]);
        expect(nativeCopyCommand("win32", false)).toEqual(["clip"]);
        expect(nativeCopyCommand("linux", true)).toEqual(["wl-copy"]);
        expect(nativeCopyCommand("linux", false)).toEqual(["xclip", "-selection", "clipboard"]);
    });
});
