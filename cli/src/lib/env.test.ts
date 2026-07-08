import { describe, expect, test } from "bun:test";

import { devChannelActive } from "./env.ts";

// The truth table behind devCommandsEnabled: dev commands register unless the baked channel is
// exactly "release" without the runtime override. We test the pure helper because the accessor's
// real inputs (bakedEnv.buildChannel, process.env.INFLEXA_DEV) are frozen at import.
describe("devChannelActive", () => {
    test("release channel, no override → disabled", () => {
        expect(devChannelActive("release", undefined)).toBe(false);
    });

    test("release channel, override on → enabled (the shipped-binary escape hatch)", () => {
        expect(devChannelActive("release", "1")).toBe(true);
    });

    test("dev channel, no override → enabled", () => {
        expect(devChannelActive("dev", undefined)).toBe(true);
    });

    test("dev channel, override on → enabled", () => {
        expect(devChannelActive("dev", "1")).toBe(true);
    });

    test("unset channel (bun run dev), no override → enabled", () => {
        expect(devChannelActive(undefined, undefined)).toBe(true);
    });

    test("unset channel, override on → enabled", () => {
        expect(devChannelActive(undefined, "1")).toBe(true);
    });

    test('release channel, override present but not exactly "1" → disabled', () => {
        expect(devChannelActive("release", "0")).toBe(false);
        expect(devChannelActive("release", "")).toBe(false);
        expect(devChannelActive("release", "true")).toBe(false);
    });
});
