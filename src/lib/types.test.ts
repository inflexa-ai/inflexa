import { describe, expect, test } from "bun:test";

import { asStr256, str256 } from "./types.ts";

describe("str256", () => {
    test("trims surrounding whitespace from the accepted value", () => {
        // Through `string`: the unwrapped value is the opaque Str256 brand, but we assert its text.
        const trimmed: string = str256("  hi  ")._unsafeUnwrap();
        expect(trimmed).toBe("hi");
    });

    test("rejects empty and whitespace-only input as 'empty'", () => {
        for (const input of ["", "   "]) {
            str256(input).match(
                () => {
                    throw new Error(`"${input}" should not validate`);
                },
                (e) => expect(e).toBe("empty"),
            );
        }
    });

    test("accepts exactly 256 code points but rejects 257 as 'too_long'", () => {
        expect(str256("a".repeat(256))._unsafeUnwrap()).toHaveLength(256);
        str256("a".repeat(257)).match(
            () => {
                throw new Error("257 chars should exceed the bound");
            },
            (e) => expect(e).toBe("too_long"),
        );
    });

    test("measures length in code points, not UTF-16 units", () => {
        // "😀" is one code point but two UTF-16 units. Accepting 256 of them (= 512 .length units)
        // proves the bound counts code points; if it counted units it would reject at 128.
        const emoji = "😀";
        expect(str256(emoji.repeat(256))._unsafeUnwrap()).toHaveLength(512);
        str256(emoji.repeat(257)).match(
            () => {
                throw new Error("257 code points should exceed the bound");
            },
            (e) => expect(e).toBe("too_long"),
        );
    });

    test("trims before measuring, so surrounding whitespace doesn't count toward the bound", () => {
        expect(str256(`  ${"a".repeat(256)}  `)._unsafeUnwrap()).toHaveLength(256);
    });
});

describe("asStr256", () => {
    test("brands a trusted string without trimming or validating (the unchecked escape hatch)", () => {
        const input = "  untrimmed  ";
        // Assign through `string` so the matcher compares plain strings, not the opaque brand.
        const branded: string = asStr256(input);
        expect(branded).toBe(input);
    });
});
