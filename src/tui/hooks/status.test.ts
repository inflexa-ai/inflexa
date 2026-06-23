import { afterEach, describe, expect, test } from "bun:test";

import { chatStatus, setChatStatus } from "./status.ts";

afterEach(() => {
    setChatStatus("idle");
});

describe("chat status store", () => {
    test("setChatStatus updates the readable status across all values", () => {
        setChatStatus("busy");
        expect(chatStatus()).toBe("busy");
        setChatStatus("error");
        expect(chatStatus()).toBe("error");
        setChatStatus("idle");
        expect(chatStatus()).toBe("idle");
    });
});
