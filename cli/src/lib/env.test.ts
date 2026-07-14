import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { devCommandsActive, env, envDoc, isDevelopmentBuild, isUnsandboxedTestRun } from "./env.ts";

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

// The truth table behind env.ts's import-time data-loss guard. The guard itself runs during module
// evaluation — by the time this file executes it has already decided — so only the pure helper is
// reachable from a test. That this very suite imports env.ts without exploding is the guard's happy
// path: cli/bunfig.toml's preload stamped the marker before any test module loaded.
describe("isUnsandboxedTestRun", () => {
    test("bun test with no sandbox marker → refuse", () => {
        expect(isUnsandboxedTestRun("test", undefined)).toBe(true);
    });

    test("bun test with the preload's marker → allow", () => {
        expect(isUnsandboxedTestRun("test", "/tmp/inflexa-test-AbC123")).toBe(false);
    });

    test("an empty marker is not a marker (an env var set to the empty string)", () => {
        expect(isUnsandboxedTestRun("test", "")).toBe(true);
    });

    test("a built binary bakes NODE_ENV to its channel, never test → allow", () => {
        expect(isUnsandboxedTestRun("production", undefined)).toBe(false);
        expect(isUnsandboxedTestRun("development", undefined)).toBe(false);
    });

    test("bun run dev leaves NODE_ENV unset → allow", () => {
        expect(isUnsandboxedTestRun(undefined, undefined)).toBe(false);
    });
});

// The direct-connection secret channel: exposed on the frozen env object (its sole reader) and
// documented in envDoc for --help. env freezes its process.env read at import, so the presence/absence
// behavior itself is exercised where it is consumed (the boot's readModelApiKey seam, runtime.test.ts);
// here we assert only that the surface exists and is a string-or-undefined secret, never persisted.
describe("INFLEXA_MODEL_API_KEY", () => {
    test("env exposes modelApiKey as a string-or-absent secret", () => {
        expect("modelApiKey" in env).toBe(true);
        // Present ⇒ a string; absent ⇒ undefined — never any other shape.
        expect(env.modelApiKey === undefined || typeof env.modelApiKey === "string").toBe(true);
    });

    test("envDoc documents INFLEXA_MODEL_API_KEY as an environment variable", () => {
        const entry = envDoc.modelApiKey;
        expect(entry.kind).toBe("var");
        if (entry.kind !== "var") throw new Error("expected a var entry");
        expect(entry.name).toBe("INFLEXA_MODEL_API_KEY");
    });
});

describe("reference-data paths", () => {
    test("refsDir resolves below the platform data home and is documented", () => {
        const dataHome = process.platform === "win32" ? Bun.env.LOCALAPPDATA : Bun.env.XDG_DATA_HOME;
        if (dataHome === undefined) throw new Error("test preload must provide the platform data home");
        expect(env.refsDir).toBe(join(dataHome, "inflexa", "refs"));
        expect(envDoc.refsDir).toMatchObject({ kind: "path", label: "references" });
        expect(envDoc.referenceDataBaseUrl).toMatchObject({ kind: "var", name: "INFLEXA_REFERENCE_DATA_BASE_URL" });
    });
});
