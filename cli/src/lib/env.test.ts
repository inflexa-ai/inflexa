import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUIDv7 } from "bun";

import {
    anthropicAuthTokenSet,
    createCredentialSource,
    detectProviderEnv,
    devCommandsActive,
    env,
    envDoc,
    isDevelopmentBuild,
    isUnsandboxedTestRun,
    modelConnectionEnvDoc,
    providerApiKeyVar,
    resolveModelApiKey,
    staticCredentialSource,
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

// The refreshing direct-mode credential source: env + command kinds, cache/refresh, and the two output
// formats. The command kinds spawn a real `/bin/sh` (deterministic counter / JSON commands) so the
// spawn+parse boundary is exercised end-to-end. env.test.ts may drive process.env directly (eslint ignore).
describe("createCredentialSource", () => {
    const scratch: string[] = [];
    /** A file-backed counter command whose stdout increments ("1", "2", …) on every invocation — proves cached vs re-run. */
    function counterCommand(): string {
        const file = join(tmpdir(), `cred-counter-${randomUUIDv7()}`);
        scratch.push(file);
        return `printf x >> '${file}'; wc -c < '${file}' | tr -d ' \\n'`;
    }
    /** A counter command that emits ExecCredential JSON with the given expiry, so the token also increments per run. */
    function execCredCommand(expiry: string): string {
        const file = join(tmpdir(), `cred-exec-${randomUUIDv7()}`);
        scratch.push(file);
        return `printf x >> '${file}'; n=$(wc -c < '${file}' | tr -d ' \\n'); printf '{"apiVersion":"client.authentication.k8s.io/v1","status":{"token":"tok-%s","expirationTimestamp":"%s"}}' "$n" "${expiry}"`;
    }

    afterEach(() => {
        for (const f of scratch.splice(0)) rmSync(f, { force: true });
        delete process.env.CRED_TEST_TOKEN;
    });

    test("env kind reads the named variable and yields the configured scheme, no expiry", async () => {
        process.env.CRED_TEST_TOKEN = "env-tok";
        const cred = (await createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "bearer" }).get())._unsafeUnwrap();
        expect(cred).toEqual({ token: "env-tok", scheme: "bearer" });
    });

    test("env kind errors when the variable is unset", async () => {
        const result = await createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "bearer" }).get();
        expect(result._unsafeUnwrapErr()).toEqual({ type: "env_var_unset", var: "CRED_TEST_TOKEN" });
    });

    test("env kind caches until forceRefresh re-reads the live variable", async () => {
        process.env.CRED_TEST_TOKEN = "v1";
        const source = createCredentialSource({ kind: "env", var: "CRED_TEST_TOKEN", scheme: "x-api-key" });
        expect((await source.get())._unsafeUnwrap().token).toBe("v1");
        process.env.CRED_TEST_TOKEN = "v2";
        // No expiry ⇒ get() keeps serving the cached value; only forceRefresh re-reads.
        expect((await source.get())._unsafeUnwrap().token).toBe("v1");
        expect((await source.forceRefresh())._unsafeUnwrap().token).toBe("v2");
        expect((await source.get())._unsafeUnwrap().token).toBe("v2");
    });

    test("command raw token is minted once, cached across get()s, and re-minted on forceRefresh", async () => {
        // ttlMs 60s > the 30s refresh buffer, so the token stays cached across get()s within the test.
        const source = createCredentialSource({ kind: "command", command: counterCommand(), scheme: "bearer", ttlMs: 60_000 });
        const first = (await source.get())._unsafeUnwrap();
        expect(first.token).toBe("1");
        expect(first.scheme).toBe("bearer");
        expect(first.expiresAt).toBeGreaterThan(Date.now());
        // Cached: the command does not re-run per request.
        expect((await source.get())._unsafeUnwrap().token).toBe("1");
        // forceRefresh (the 401 path) re-runs the command.
        expect((await source.forceRefresh())._unsafeUnwrap().token).toBe("2");
    });

    test("command raw token with empty output errors", async () => {
        const result = await createCredentialSource({ kind: "command", command: "true", scheme: "x-api-key" }).get();
        expect(result._unsafeUnwrapErr().type).toBe("command_empty_output");
    });

    test("a non-zero command exit surfaces as an actionable error, never a throw", async () => {
        const result = await createCredentialSource({ kind: "command", command: "echo boom >&2; exit 3", scheme: "bearer" }).get();
        const e = result._unsafeUnwrapErr();
        expect(e.type).toBe("command_exit_nonzero");
        if (e.type === "command_exit_nonzero") expect(e.exitCode).toBe(3);
    });

    test("exec-credential format parses status.token + expirationTimestamp and caches until near expiry", async () => {
        const future = new Date(Date.now() + 3_600_000).toISOString();
        const source = createCredentialSource({ kind: "command", command: execCredCommand(future), scheme: "bearer", format: "exec-credential" });
        const cred = (await source.get())._unsafeUnwrap();
        expect(cred.token).toBe("tok-1");
        expect(cred.expiresAt).toBe(Date.parse(future));
        // Far-future expiry ⇒ cached across get()s.
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-1");
    });

    test("exec-credential expiry drives refresh: a past expiry re-runs the command on the next get()", async () => {
        const past = new Date(Date.now() - 60_000).toISOString();
        const source = createCredentialSource({ kind: "command", command: execCredCommand(past), scheme: "bearer", format: "exec-credential" });
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-1");
        // Already past expiry (minus buffer) ⇒ the next get() re-mints rather than serving a stale token.
        expect((await source.get())._unsafeUnwrap().token).toBe("tok-2");
    });

    test("exec-credential format rejects non-ExecCredential JSON with an actionable error", async () => {
        const result = await createCredentialSource({
            kind: "command",
            command: `printf '{"hello":"world"}'`,
            scheme: "bearer",
            format: "exec-credential",
        }).get();
        expect(result._unsafeUnwrapErr().type).toBe("exec_credential_invalid");
    });
});

describe("staticCredentialSource", () => {
    test("wraps a known token as an expiry-less source (get and forceRefresh both yield it)", async () => {
        const source = staticCredentialSource("static-key", "x-api-key");
        expect((await source.get())._unsafeUnwrap()).toEqual({ token: "static-key", scheme: "x-api-key" });
        expect((await source.forceRefresh())._unsafeUnwrap().token).toBe("static-key");
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
