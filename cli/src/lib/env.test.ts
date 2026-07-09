import { describe, expect, test } from "bun:test";

import { devCommandsActive, isDevelopmentBuild } from "./env.ts";

// The truth table behind env.isDevelopment: a build is development unless the baked channel is exactly
// "production". We test the pure helper because env freezes its bakedEnv.buildChannel read at import.
// Unlike devCommandsActive, this axis does NOT widen on INFLEXA_DEV=1 — it governs file/container
// layout, which must stay production-shaped even when support re-enables dev commands on a shipped binary.
describe("isDevelopmentBuild", () => {
    test("production channel → not a development build", () => {
        expect(isDevelopmentBuild("production")).toBe(false);
    });

    test("any other channel → development build", () => {
        expect(isDevelopmentBuild("development")).toBe(true);
        expect(isDevelopmentBuild("beta")).toBe(true);
    });

    test("unset channel (bun run dev) → development build", () => {
        expect(isDevelopmentBuild(undefined)).toBe(true);
    });
});

// The truth table behind devCommandsEnabled: dev commands register unless the baked channel is
// exactly "production" without the runtime override. We test the pure helper because the accessor's
// real inputs (bakedEnv.buildChannel, process.env.INFLEXA_DEV) are frozen at import.
describe("devCommandsActive", () => {
    test("production channel, no override → disabled", () => {
        expect(devCommandsActive("production", undefined)).toBe(false);
    });

    test("production channel, override on → enabled (the shipped-binary escape hatch)", () => {
        expect(devCommandsActive("production", "1")).toBe(true);
    });

    test("development channel, no override → enabled", () => {
        expect(devCommandsActive("development", undefined)).toBe(true);
    });

    test("development channel, override on → enabled", () => {
        expect(devCommandsActive("development", "1")).toBe(true);
    });

    test("unset channel (bun run dev), no override → enabled", () => {
        expect(devCommandsActive(undefined, undefined)).toBe(true);
    });

    test("unset channel, override on → enabled", () => {
        expect(devCommandsActive(undefined, "1")).toBe(true);
    });

    test('production channel, override present but not exactly "1" → disabled', () => {
        expect(devCommandsActive("production", "0")).toBe(false);
        expect(devCommandsActive("production", "")).toBe(false);
        expect(devCommandsActive("production", "true")).toBe(false);
    });
});
