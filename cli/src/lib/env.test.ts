import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
    anthropicAuthTokenSet,
    detectProviderEnv,
    devCommandsActive,
    env,
    envDoc,
    isDevelopmentBuild,
    isUnsandboxedTestRun,
    modelConnectionEnvDoc,
    providerApiKeyVar,
    resolveModelApiKey,
    stackPaths,
    stackPorts,
} from "./env.ts";

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

// The channel-aware stack identity. We test the pure helpers (not `env.*`) because `env` freezes its
// bakedEnv.buildChannel read at import and cannot be re-driven in a test process — the same reason
// isDevelopmentBuild is split out. Production values are pinned to their historical literals so a prod
// install is provably untouched; dev gets fixed siblings that must never collide with them.
describe("stackPorts", () => {
    test("production → the historical proxy 8317 / postgres 8432 pair", () => {
        expect(stackPorts("production")).toEqual({ cliproxy: 8317, postgres: 8432 });
    });

    test("dev (unset or any non-production channel) → sibling proxy 8318 / postgres 8433", () => {
        expect(stackPorts(undefined)).toEqual({ cliproxy: 8318, postgres: 8433 });
        expect(stackPorts("development")).toEqual({ cliproxy: 8318, postgres: 8433 });
        expect(stackPorts("beta")).toEqual({ cliproxy: 8318, postgres: 8433 });
    });

    test("dev postgres port avoids 5433 (the harness testcontainer) and 5432 (system PG)", () => {
        expect(stackPorts(undefined).postgres).not.toBe(5433);
        expect(stackPorts(undefined).postgres).not.toBe(5432);
    });

    test("every dev port differs from its production sibling, so the two stacks never contend for a bind", () => {
        const prod = stackPorts("production");
        const dev = stackPorts("development");
        expect(dev.cliproxy).not.toBe(prod.cliproxy);
        expect(dev.postgres).not.toBe(prod.postgres);
    });
});

describe("stackPaths", () => {
    const base = "/data";

    test("production paths are byte-identical to their historical form", () => {
        expect(stackPaths(base, "production")).toEqual({
            cliproxyConfigPath: join(base, "inflexa", "cliproxy", "config.yaml"),
            cliproxyAuthDir: join(base, "inflexa", "cliproxy", "auth"),
            postgresDataDir: join(base, "inflexa", "postgres"),
            composeFilePath: join(base, "inflexa", "docker-compose.yml"),
        });
    });

    test("dev paths are the sibling variants (cliproxy-dev/, postgres-dev/, docker-compose.dev.yml)", () => {
        expect(stackPaths(base, undefined)).toEqual({
            cliproxyConfigPath: join(base, "inflexa", "cliproxy-dev", "config.yaml"),
            cliproxyAuthDir: join(base, "inflexa", "cliproxy-dev", "auth"),
            postgresDataDir: join(base, "inflexa", "postgres-dev"),
            composeFilePath: join(base, "inflexa", "docker-compose.dev.yml"),
        });
    });

    test("no stack path is shared across channels — the whole mount/compose surface is disjoint", () => {
        const prod = Object.values(stackPaths(base, "production"));
        const dev = Object.values(stackPaths(base, "development"));
        // Every prod path is absent from the dev set (and vice versa), and the union is 8 distinct paths:
        // a single shared entry would re-open a collision (shared PGDATA, one build rewriting the other's
        // compose file, or — worst — a shared proxy credential dir the OAuth rotation would corrupt).
        for (const p of prod) expect(dev).not.toContain(p);
        expect(new Set([...prod, ...dev]).size).toBe(8);
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

// The direct-connection secret channel is resolved on demand (never an eager `env` field) by
// resolveModelApiKey, parameterized by the connection's provider. Because it reads process.env at call
// time (not import), the precedence is directly testable here by driving the three variables.
describe("resolveModelApiKey — direct-connection key precedence (env only)", () => {
    const KEYS = ["INFLEXA_MODEL_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        // Isolate from the developer's real environment: snapshot then clear all three before each case.
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    test("the explicit INFLEXA_MODEL_API_KEY override wins over the provider variable", () => {
        process.env.INFLEXA_MODEL_API_KEY = "sk-override";
        process.env.ANTHROPIC_API_KEY = "sk-ant";
        expect(resolveModelApiKey("anthropic")).toBe("sk-override");
    });

    test("provider anthropic falls back to ANTHROPIC_API_KEY when the override is unset", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant";
        expect(resolveModelApiKey("anthropic")).toBe("sk-ant");
    });

    test("every other provider falls back to OPENAI_API_KEY (the openai-compatible long tail)", () => {
        process.env.OPENAI_API_KEY = "sk-openai";
        expect(resolveModelApiKey("openai")).toBe("sk-openai");
        expect(resolveModelApiKey("deepseek")).toBe("sk-openai");
    });

    test("anthropic ignores OPENAI_API_KEY", () => {
        process.env.OPENAI_API_KEY = "sk-openai";
        expect(resolveModelApiKey("anthropic")).toBeUndefined();
    });

    test("a non-anthropic provider ignores ANTHROPIC_API_KEY", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant";
        expect(resolveModelApiKey("openai")).toBeUndefined();
    });

    test("nothing set → undefined", () => {
        expect(resolveModelApiKey("anthropic")).toBeUndefined();
        expect(resolveModelApiKey("openai")).toBeUndefined();
    });
});

describe("providerApiKeyVar", () => {
    test("anthropic → ANTHROPIC_API_KEY; every other provider → OPENAI_API_KEY", () => {
        expect(providerApiKeyVar("anthropic")).toBe("ANTHROPIC_API_KEY");
        expect(providerApiKeyVar("openai")).toBe("OPENAI_API_KEY");
        expect(providerApiKeyVar("deepseek")).toBe("OPENAI_API_KEY");
    });
});

// The one-time setup detection: reports presence + raw base URLs, deliberately WITHOUT the key value
// (setup copies only the non-secret fields; the key stays an environment read via resolveModelApiKey).
describe("detectProviderEnv", () => {
    const KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });
    afterEach(() => {
        for (const k of KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    });

    test("reports whether each API key is set — never its value — plus the raw base URLs", () => {
        process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
        process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
        const snap = detectProviderEnv();
        expect(snap).toEqual({
            anthropicApiKeySet: true,
            anthropicBaseURL: "https://api.anthropic.com",
            openaiApiKeySet: false,
            openaiBaseURL: undefined,
        });
        // The snapshot must never carry the key value.
        expect(JSON.stringify(snap)).not.toContain("sk-ant-secret");
    });

    test("an empty *_BASE_URL is treated as unset (undefined)", () => {
        process.env.OPENAI_API_KEY = "sk-openai";
        process.env.OPENAI_BASE_URL = "";
        const snap = detectProviderEnv();
        expect(snap.openaiApiKeySet).toBe(true);
        expect(snap.openaiBaseURL).toBeUndefined();
    });
});

describe("model-connection env documentation", () => {
    test("modelConnectionEnvDoc names INFLEXA_MODEL_API_KEY and the provider-conventional fallback vars", () => {
        const names = modelConnectionEnvDoc.map((d) => d.name);
        expect(names).toContain("INFLEXA_MODEL_API_KEY");
        expect(names.some((n) => n.includes("ANTHROPIC_API_KEY") && n.includes("OPENAI_API_KEY"))).toBe(true);
    });

    test("the secret is no longer an env field, so envDoc carries no modelApiKey entry", () => {
        expect(Object.keys(envDoc)).not.toContain("modelApiKey");
    });
});

describe("anthropicAuthTokenSet", () => {
    const saved = process.env.ANTHROPIC_AUTH_TOKEN;
    afterEach(() => {
        if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
        else process.env.ANTHROPIC_AUTH_TOKEN = saved;
    });
    test("reports presence of ANTHROPIC_AUTH_TOKEN without exposing its value", () => {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        expect(anthropicAuthTokenSet()).toBe(false);
        process.env.ANTHROPIC_AUTH_TOKEN = "sk-ant-oat-secret";
        expect(anthropicAuthTokenSet()).toBe(true);
    });
});

describe("reference-data paths", () => {
    test("refsDir resolves below the platform data home and is documented", () => {
        const dataHome = process.platform === "win32" ? Bun.env.LOCALAPPDATA : Bun.env.XDG_DATA_HOME;
        if (dataHome === undefined) throw new Error("test preload must provide the platform data home");
        expect(env.refsDir).toBe(join(dataHome, "inflexa", "refs"));
        expect(envDoc.refsDir).toMatchObject({ kind: "path", label: "references" });
        // Reference artifacts are fetched from the upstream that publishes them, so there is
        // no distribution endpoint to configure and no env var that could point one elsewhere.
        expect(Object.keys(envDoc)).not.toContain("referenceDataBaseUrl");
    });
});
