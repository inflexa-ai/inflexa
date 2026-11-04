import { describe, expect, test } from "bun:test";

import { formatIecBytes } from "../bytes.ts";

describe("formatIecBytes", () => {
    test("gives whole bytes below 1024", () => {
        expect(formatIecBytes(0)).toBe("0 B");
        expect(formatIecBytes(1023)).toBe("1023 B");
    });

    test("gives KiB with one decimal from 1024", () => {
        expect(formatIecBytes(1024)).toBe("1.0 KiB");
        expect(formatIecBytes(1536)).toBe("1.5 KiB");
    });

    test("gives a value in each larger unit", () => {
        expect(formatIecBytes(1024 ** 2)).toBe("1.0 MiB");
        expect(formatIecBytes(5 * 1024 ** 3)).toBe("5.0 GiB");
        expect(formatIecBytes(2.5 * 1024 ** 4)).toBe("2.5 TiB");
    });

    test("moves to the next unit at the 1024 boundary of the lower one", () => {
        expect(formatIecBytes(1024 ** 2 - 1)).toBe("1024.0 KiB");
        expect(formatIecBytes(1024 ** 2)).toBe("1.0 MiB");
    });

    test("stays in TiB above the top unit", () => {
        expect(formatIecBytes(2048 * 1024 ** 4)).toBe("2048.0 TiB");
    });
});
