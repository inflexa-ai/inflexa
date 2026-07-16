import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ok, err } from "neverthrow";
import {
    adoptedConnection,
    classifyModelResolution,
    detectedAdoptable,
    ensureLiveCredential,
    hasProviderCredential,
    normalizeAdoptedBaseURL,
    parseConnectionMode,
    providerKindForSlug,
    recordCliproxyProvider,
    retryWhileUnreachable,
    writeDirectConnection,
    type ProbeAttempt,
} from "./setup.ts";
import { readConfig } from "../../lib/config.ts";
import { env, type ProviderEnvSnapshot } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

/** Build a provider-env snapshot for the adoption helpers; every field defaults to "absent". */
function snapshot(overrides: Partial<ProviderEnvSnapshot> = {}): ProviderEnvSnapshot {
    return { anthropicApiKeySet: false, anthropicBaseURL: undefined, openaiApiKeySet: false, openaiBaseURL: undefined, ...overrides };
}

// generateApiKey + proxyConfig live in proxy_config.ts alongside writeProxyConfig; their unit tests
// live beside them in proxy_config.test.ts.

describe("parseConnectionMode", () => {
    test("an absent flag resolves to undefined (mode chosen interactively / defaulted)", () => {
        expect(parseConnectionMode(undefined)._unsafeUnwrap()).toBeUndefined();
    });

    test("accepts the two valid modes verbatim", () => {
        expect(parseConnectionMode("cliproxy")._unsafeUnwrap()).toBe("cliproxy");
        expect(parseConnectionMode("direct")._unsafeUnwrap()).toBe("direct");
    });

    test("rejects any other value with an actionable message", () => {
        const error = parseConnectionMode("proxy").match(
            () => null,
            (e) => e,
        );
        expect(error).not.toBeNull();
        expect(error?.message).toContain("cliproxy, direct");
    });
});

describe("normalizeAdoptedBaseURL", () => {
    test("a bare anthropic root gets /v1 appended (the wire layer needs the terminated form)", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1");
    });

    test("an already /v1-terminated URL is left unchanged (the openai convention)", () => {
        expect(normalizeAdoptedBaseURL("openai", "https://gw.corp/v1")).toBe("https://gw.corp/v1");
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1");
    });

    test("any /vN version segment counts as terminated (not just v1)", () => {
        expect(normalizeAdoptedBaseURL("openai", "https://gw.corp/v2")).toBe("https://gw.corp/v2");
    });

    test("an ambiguous gateway root without a version segment gets /v1 appended (the confirmable best guess)", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://gw.corp/anthropic")).toBe("https://gw.corp/anthropic/v1");
    });

    test("a trailing slash never produces a doubled //v1", () => {
        expect(normalizeAdoptedBaseURL("anthropic", "https://api.anthropic.com/")).toBe("https://api.anthropic.com/v1");
    });

    test("an unset base URL defaults to the provider public root", () => {
        expect(normalizeAdoptedBaseURL("anthropic", undefined)).toBe("https://api.anthropic.com/v1");
        expect(normalizeAdoptedBaseURL("openai", undefined)).toBe("https://api.openai.com/v1");
        expect(normalizeAdoptedBaseURL("openai", "  ")).toBe("https://api.openai.com/v1");
    });
});

describe("ecosystem env adoption — detection → non-secret connection", () => {
    test("anthropic detection adopts the normalized connection (no key)", () => {
        const snap = snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" });
        expect(detectedAdoptable(snap)).toEqual(["anthropic"]);
        expect(adoptedConnection("anthropic", snap)).toEqual({
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
        });
    });

    test("openai detection adopts its /v1-terminated gateway verbatim as openai-compatible", () => {
        const snap = snapshot({ openaiApiKeySet: true, openaiBaseURL: "https://gw.corp/v1" });
        expect(detectedAdoptable(snap)).toEqual(["openai"]);
        expect(adoptedConnection("openai", snap)).toEqual({
            provider: "openai",
            baseURL: "https://gw.corp/v1",
            protocol: "openai-compatible",
        });
    });

    test("key present but base URL absent defaults to the provider root", () => {
        expect(adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true })).baseURL).toBe("https://api.anthropic.com/v1");
        expect(adoptedConnection("openai", snapshot({ openaiApiKeySet: true })).baseURL).toBe("https://api.openai.com/v1");
    });

    test("both ecosystems present tiebreak deterministically anthropic-before-openai", () => {
        expect(detectedAdoptable(snapshot({ anthropicApiKeySet: true, openaiApiKeySet: true }))).toEqual(["anthropic", "openai"]);
    });

    test("no provider env is detected as nothing adoptable", () => {
        expect(detectedAdoptable(snapshot())).toEqual([]);
    });

    test("an adopted connection carries only the non-secret fields (never a key)", () => {
        const conn = adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" }));
        expect(Object.keys(conn).sort()).toEqual(["baseURL", "protocol", "provider"]);
    });
});

// The config-writing tests round-trip through the real readConfig()/writeConfig() surface against the
// sandboxed env.configPath (set by the test preload). Guard first, in the hooks: at the monorepo root
// that path is the developer's REAL config.json (data-loss guard — test_support/sandbox.ts).
describe("connection config writes", () => {
    beforeEach(() => {
        assertTestSandbox(env.configPath);
    });

    afterEach(() => {
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
    });

    // `readConfig().models` is `unknown` (validated downstream); read it as a record to inspect what
    // the setup writers persisted.
    function readModels(): Record<string, unknown> {
        return (readConfig().models ?? {}) as Record<string, unknown>;
    }

    function seedConfig(value: Record<string, unknown>): void {
        mkdirSync(dirname(env.configPath), { recursive: true });
        writeFileSync(env.configPath, JSON.stringify(value));
    }

    test("recordCliproxyProvider maps the account kind to its provider slug", () => {
        // _unsafeUnwrap throws on an Err (a test file may — an unexpected write failure IS the failure).
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("every account kind maps to the documented slug", () => {
        recordCliproxyProvider("openai")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "openai" });
        recordCliproxyProvider("gemini")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "google" });
        recordCliproxyProvider("qwen")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "qwen" });
        recordCliproxyProvider("iflow")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "iflow" });
    });

    test("re-authenticating a different account kind rewrites the provider slug", () => {
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
        recordCliproxyProvider("gemini")._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "google" });
    });

    test("recording is spread-preserving — other config keys and other models keys survive", () => {
        // A pre-existing sibling inside the models block (the `agents` block, opaque to the connection
        // writer) and an unrelated top-level key must both survive the connection rewrite.
        seedConfig({ telemetry: true, models: { agents: { chat: "x" }, connection: { mode: "cliproxy", provider: "openai" } } });
        recordCliproxyProvider("claude")._unsafeUnwrap();
        expect(readConfig().telemetry).toBe(true);
        expect(readModels().agents).toEqual({ chat: "x" });
        expect(readModels().connection).toEqual({ mode: "cliproxy", provider: "anthropic" });
    });

    test("writeDirectConnection persists mode/provider/baseURL and omits protocol when unset", () => {
        writeDirectConnection({ provider: "openai", baseURL: "https://api.openai.com/v1" })._unsafeUnwrap();
        expect(readModels().connection).toEqual({ mode: "direct", provider: "openai", baseURL: "https://api.openai.com/v1" });
    });

    test("writeDirectConnection persists an explicit protocol override", () => {
        writeDirectConnection({ provider: "anthropic", baseURL: "https://gw.example/v1", protocol: "openai-compatible" })._unsafeUnwrap();
        expect(readModels().connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://gw.example/v1",
            protocol: "openai-compatible",
        });
    });

    test("an adopted ecosystem connection persists to config with no key material", () => {
        // Adopt an anthropic env, write it, and assert config.json carries the three non-secret fields and
        // no key: the whole config text must not contain any key-shaped material.
        const conn = adoptedConnection("anthropic", snapshot({ anthropicApiKeySet: true, anthropicBaseURL: "https://api.anthropic.com" }));
        writeDirectConnection(conn)._unsafeUnwrap();
        expect(readModels().connection).toEqual({
            mode: "direct",
            provider: "anthropic",
            baseURL: "https://api.anthropic.com/v1",
            protocol: "anthropic",
        });
        const configText = JSON.stringify(readConfig());
        expect(configText.toLowerCase()).not.toContain("apikey");
        expect(configText).not.toContain("ANTHROPIC_API_KEY");
    });

    test("writeDirectConnection writes only endpoint facts (no secret key) and preserves models siblings", () => {
        seedConfig({ telemetry: false, models: { agents: { chat: "y" } } });
        writeDirectConnection({ provider: "deepseek", baseURL: "https://api.deepseek.com/v1" })._unsafeUnwrap();
        expect(readModels().agents).toEqual({ chat: "y" });
        // The written connection carries exactly mode/provider/baseURL — no apiKey/token field. The
        // direct-mode secret lives only in INFLEXA_MODEL_API_KEY, never in config.
        expect(Object.keys(readModels().connection as Record<string, unknown>).sort()).toEqual(["baseURL", "mode", "provider"]);
    });
});

// hasProviderCredential takes the dir as a parameter, so these run against plain temp dirs — no env
// sandbox involvement, no shared state.
describe("hasProviderCredential", () => {
    let dir: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "inflexa-cred-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    test("a missing dir is unauthenticated (the ordinary never-logged-in state)", async () => {
        expect(await hasProviderCredential(join(dir, "absent"))).toBe(false);
    });

    test("a logs-only dir is unauthenticated — the vendor writes logs/ beside credentials", async () => {
        mkdirSync(join(dir, "logs"));
        expect(await hasProviderCredential(dir)).toBe(false);
    });

    test("an operator-disabled credential is unauthenticated", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), JSON.stringify({ disabled: true, expired: "2099-01-01T00:00:00Z" }));
        expect(await hasProviderCredential(dir)).toBe(false);
    });

    test("a PAST expired timestamp does not fail the static check — the proxy refreshes access tokens", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), JSON.stringify({ disabled: false, expired: "2020-01-01T00:00:00Z" }));
        expect(await hasProviderCredential(dir)).toBe(true);
    });

    test("an unparseable credential counts as present — the live probe adjudicates validity, not the parser", async () => {
        writeFileSync(join(dir, "claude-user@example.com.json"), "{not json");
        expect(await hasProviderCredential(dir)).toBe(true);
    });

    test("dotfiles and non-json entries never count", async () => {
        mkdirSync(join(dir, "logs"));
        writeFileSync(join(dir, ".hidden.json"), "{}");
        writeFileSync(join(dir, "readme.txt"), "hi");
        expect(await hasProviderCredential(dir)).toBe(false);
    });
});

describe("providerKindForSlug", () => {
    test("maps recorded slugs back to their account kind and everything else to undefined", () => {
        expect(providerKindForSlug("anthropic")).toBe("claude");
        expect(providerKindForSlug("openai")).toBe("openai");
        expect(providerKindForSlug("deepseek")).toBeUndefined();
        expect(providerKindForSlug(undefined)).toBeUndefined();
    });
});

// The launch-gate policy matrix, driven through injected seams — no terminal, container runtime, or
// clack involved. `probes` is consumed in order so each call observes the scripted next outcome.
describe("ensureLiveCredential", () => {
    type Probe = { kind: "ok" } | { kind: "unauthorized" } | { kind: "unobservable"; detail: string };

    function scripted(probes: Probe[], over: Partial<Parameters<typeof ensureLiveCredential>[0]> = {}) {
        const calls: string[] = [];
        const deps: Parameters<typeof ensureLiveCredential>[0] = {
            probe: async () => {
                calls.push("probe");
                return probes.shift() ?? { kind: "ok" };
            },
            relogin: async () => {
                calls.push("relogin");
                return true;
            },
            restartProxy: async () => {
                calls.push("restart");
                return ok<void, { message: string }>(undefined);
            },
            isInteractive: () => true,
            // Not recorded: announcing is narration, not a policy step, and asserting it would pin the
            // wording of every re-login message into the matrix below.
            announce: () => {},
            warn: () => {
                calls.push("warn");
            },
            ...over,
        };
        return { deps, calls };
    }

    test("a healthy probe proceeds without touching the login", async () => {
        const { deps, calls } = scripted([{ kind: "ok" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe"]);
    });

    test("an unobservable probe (outage, timeout, cold container) warns and proceeds — never blocks launch", async () => {
        const { deps, calls } = scripted([{ kind: "unobservable", detail: "HTTP 503" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "warn"]);
    });

    test("a 401 on a non-TTY fails actionably naming the forced re-login command", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], { isInteractive: () => false });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr()).toBe(true);
        expect(result.isErr() ? result.error.message : "").toContain("inflexa setup --provider");
        expect(calls).toEqual(["probe"]);
    });

    test("a 401 on a TTY drives re-login, restarts the proxy BEFORE re-probing, then proceeds", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "ok" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "relogin", "restart", "probe"]);
    });

    test("an incomplete re-login fails without restarting or re-probing", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], { relogin: async () => false });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("didn't complete");
        expect(calls).toEqual(["probe"]);
    });

    test("a failed proxy restart fails rather than re-probing a proxy that never saw the fresh login", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }], {
            restartProxy: async () => err({ message: "compose exploded" }),
        });
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("restart");
        expect(calls).toEqual(["probe", "relogin"]);
    });

    test("a second 401 after re-login fails hard naming both remaining causes", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "unauthorized" }]);
        const result = await ensureLiveCredential(deps);
        expect(result.isErr() ? result.error.message : "").toContain("Still unauthorized");
        expect(calls).toEqual(["probe", "relogin", "restart", "probe"]);
    });

    test("an unobservable re-probe after re-login warns and proceeds", async () => {
        const { deps, calls } = scripted([{ kind: "unauthorized" }, { kind: "unobservable", detail: "HTTP 502" }]);
        expect((await ensureLiveCredential(deps)).isOk()).toBe(true);
        expect(calls).toEqual(["probe", "relogin", "restart", "probe", "warn"]);
    });
});

// How a raw attempt becomes a verdict the policy above can act on. These are the two seams where a
// misread turns the launch gate into a no-op: a boot race read as an outage, or an outage read as a
// rejection.
describe("classifyModelResolution", () => {
    test("an empty model list is a credential verdict — the proxy answered, and it has nothing to serve with", () => {
        expect(classifyModelResolution({ type: "no_models" })).toEqual({ kind: "unauthorized" });
    });

    test("a 401 from /models is the credential verdict, not an outage", () => {
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "HTTP 401" })).toEqual({ kind: "unauthorized" });
    });

    test("a served status that is not 401 is unobservable — a fault, but not one about the credential", () => {
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "HTTP 503" })).toEqual({
            kind: "unobservable",
            detail: "proxy_unreachable: HTTP 503",
        });
    });

    test("silence is unreachable, NOT unobservable — it is the retryable one", () => {
        // The shape resolveModelId reports for a refused connection (see its own tests).
        expect(classifyModelResolution({ type: "proxy_unreachable", detail: "socket hang up" })).toEqual({
            kind: "unreachable",
            detail: "socket hang up",
        });
    });

    test("a missing client key is unobservable — nothing was asked, so nothing was learned", () => {
        expect(classifyModelResolution({ type: "proxy_key_missing" })).toEqual({ kind: "unobservable", detail: "proxy_key_missing" });
    });
});

// The readiness wait the probe has instead of a health endpoint. Budget/pause are injected so these
// run in milliseconds rather than the production 10s.
describe("retryWhileUnreachable", () => {
    test("retries silence until the proxy answers, then returns that verdict", async () => {
        const outcomes: ProbeAttempt[] = [{ kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "ok" }];
        let tries = 0;
        const result = await retryWhileUnreachable(
            async () => {
                tries++;
                return outcomes.shift() ?? { kind: "ok" };
            },
            1_000,
            1,
        );
        expect(result).toEqual({ kind: "ok" });
        expect(tries).toBe(3);
    });

    test("a 401 behind a cold container is still caught — the wait does not swallow the verdict it exists to reach", async () => {
        const outcomes: ProbeAttempt[] = [{ kind: "unreachable", detail: "ECONNREFUSED" }, { kind: "unauthorized" }];
        const result = await retryWhileUnreachable(async () => outcomes.shift() ?? { kind: "ok" }, 1_000, 1);
        expect(result).toEqual({ kind: "unauthorized" });
    });

    test("a proxy silent past the budget degrades to unobservable — warn and proceed, never block", async () => {
        const result = await retryWhileUnreachable(async () => ({ kind: "unreachable", detail: "ECONNREFUSED" }), 5, 1);
        expect(result).toEqual({ kind: "unobservable", detail: "ECONNREFUSED" });
    });

    test("an answering proxy is never paced — one try, no wait", async () => {
        let tries = 0;
        const result = await retryWhileUnreachable(async () => {
            tries++;
            return { kind: "unauthorized" };
        });
        expect(result).toEqual({ kind: "unauthorized" });
        expect(tries).toBe(1);
    });
});
