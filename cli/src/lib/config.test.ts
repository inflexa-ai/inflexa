import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { ensureRuntime, readConfig, writeConfig, type Config } from "./config.ts";
import { ContainerRuntimeError, runtimes, type ContainerRuntime } from "./container.ts";
import { DEFAULT_THEME_ID } from "./design_system.ts";
import { env } from "./env.ts";
import { assertTestSandbox } from "../test_support/sandbox.ts";

// Drives config through the public readConfig/writeConfig surface against the sandboxed
// env.configPath (set by the test preload), so it exercises the real fail-closed + self-healing
// paths rather than poking the private schema.

// Every test in this file writes or deletes env.configPath (directly, or via writeConfig). Guard
// once, first, in the hooks: at the monorepo root env.configPath is the developer's REAL config.json,
// so refuse to run there rather than clobber it (data-loss guard — see test_support/sandbox.ts).
// beforeEach runs before each body, so a root run throws before any writeConfig/writeRawConfig fires.
beforeEach(() => {
    assertTestSandbox(env.configPath);
});

function writeRawConfig(json: string): void {
    mkdirSync(dirname(env.configPath), { recursive: true });
    writeFileSync(env.configPath, json);
}

afterEach(() => {
    assertTestSandbox(env.configPath);
    rmSync(env.configPath, { force: true });
});

describe("readConfig — self-healing fields", () => {
    test("coerces an invalid theme to the default, keeping the other fields", () => {
        writeRawConfig(JSON.stringify({ telemetry: true, theme: "no-such-theme" }));
        const cfg = readConfig();
        expect(cfg.theme).toBe(DEFAULT_THEME_ID);
        expect(cfg.telemetry).toBe(true);
    });

    test("treats an invalid runtime as unset, not as an implicit docker choice", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, runtime: "kubernetes" }));
        expect(readConfig().runtime).toBeUndefined();
    });

    test("an absent runtime key stays unset", () => {
        writeRawConfig(JSON.stringify({ telemetry: false }));
        expect(readConfig().runtime).toBeUndefined();
    });

    test("coerces a non-positive leaderTimeout to 2000", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, leaderTimeout: -5 }));
        expect(readConfig().leaderTimeout).toBe(2000);
    });
});

describe("readConfig — fail-closed", () => {
    test("telemetry does not self-heal: a config missing it falls back entirely (telemetry off)", () => {
        writeRawConfig(JSON.stringify({ theme: DEFAULT_THEME_ID }));
        expect(readConfig().telemetry).toBe(false);
    });

    test("malformed JSON falls back to safe defaults", () => {
        writeRawConfig("{ not valid json");
        const cfg = readConfig();
        expect(cfg.telemetry).toBe(false);
        expect(cfg.theme).toBe(DEFAULT_THEME_ID);
    });

    test("a missing config file falls back to safe defaults", () => {
        rmSync(env.configPath, { force: true });
        expect(readConfig().telemetry).toBe(false);
    });

    // A malformed field must self-heal PER FIELD like its siblings —
    // a bad value must NOT nuke the whole parse and drop telemetry consent.
    test("a malformed field is salvaged per-field, keeping siblings intact", () => {
        writeRawConfig(JSON.stringify({ telemetry: true, theme: "not-a-real-theme", leaderTimeout: 500 }));
        const cfg = readConfig();
        expect(cfg.telemetry).toBe(true); // sibling survived — no whole-config fail-closed
        expect(cfg.theme).toBe(DEFAULT_THEME_ID); // the bad field salvaged to the default
        expect(cfg.leaderTimeout).toBe(500); // the good sibling field intact
    });
});

describe("writeConfig / readConfig round-trip", () => {
    test("a written config reads back identically", () => {
        const cfg: Config = { telemetry: true, theme: DEFAULT_THEME_ID, runtime: "podman", leaderTimeout: 500, embedding: { mode: "off" } };
        writeConfig(cfg)._unsafeUnwrap();
        expect(readConfig()).toEqual(cfg);
    });
});

describe("writeConfig — canonical key order", () => {
    // The emitted bytes must be a function of the config's VALUES alone. Every caller assembles a config by
    // spreading (`{ ...readConfig(), harness }`), and a spread APPENDS a key the parsed config lacked
    // instead of placing it in schema position — so without a canonical order, two `inflexa setup --yes`
    // runs that agree on every answer still write byte-different config.json, which is exactly what the
    // setup-answers spec forbids ("byte-identical resulting configuration").

    /** Every field populated, so the assertions cover the nested blocks and the opaque ones alike. */
    const values = {
        telemetry: true,
        theme: DEFAULT_THEME_ID,
        runtime: "podman",
        keybinds: { "app.command-palette": "ctrl+p", "app.abort": "ctrl+c" },
        leaderTimeout: 500,
        postgres: { host: "localhost", port: 6000, database: "inflexa", user: "inflexa", password: "s3cret" },
        harness: { sandboxImage: "ghcr.io/x/sandbox:1", adminPort: 9000, resourceLimits: { budget: 40 } },
        models: { connection: { mode: "cliproxy", provider: "anthropic" }, agents: { conversation: "m-1", sandbox: "m-1" } },
        embedding: { mode: "api-key", apiKey: "sk-test", baseURL: "https://embeds.internal/v1", model: "text-embedding-3-small", dimensions: 1536 },
    } as const satisfies Config;

    function writeAndRead(cfg: Config): string {
        writeConfig(cfg)._unsafeUnwrap();
        return readFileSync(env.configPath, "utf8");
    }

    test("scrambled insertion order emits the same bytes as schema-ordered insertion", () => {
        // Deliberately hostile insertion at BOTH levels: the top-level keys reversed, and the interiors of
        // `postgres`/`embedding` (declared blocks) plus `harness`/`models` (opaque ones) shuffled too.
        const scrambled: Config = {
            embedding: {
                dimensions: values.embedding.dimensions,
                model: values.embedding.model,
                baseURL: values.embedding.baseURL,
                apiKey: values.embedding.apiKey,
                mode: values.embedding.mode,
            },
            models: { agents: { sandbox: "m-1", conversation: "m-1" }, connection: { provider: "anthropic", mode: "cliproxy" } },
            harness: { resourceLimits: { budget: 40 }, adminPort: 9000, sandboxImage: "ghcr.io/x/sandbox:1" },
            postgres: { password: "s3cret", user: "inflexa", database: "inflexa", port: 6000, host: "localhost" },
            leaderTimeout: values.leaderTimeout,
            keybinds: { "app.abort": "ctrl+c", "app.command-palette": "ctrl+p" },
            runtime: values.runtime,
            theme: values.theme,
            telemetry: values.telemetry,
        };

        expect(writeAndRead(scrambled)).toBe(writeAndRead(values));
    });

    test("declared keys land in schema order; undeclared ones follow, sorted", () => {
        // Pins WHICH order is canonical — a stable-but-arbitrary order would satisfy the test above just as
        // well, and the schema order is what makes a hand-edited config readable.
        const document = JSON.parse(writeAndRead(values)) as Record<string, Record<string, unknown>>;

        expect(Object.keys(document)).toEqual(["telemetry", "theme", "runtime", "keybinds", "leaderTimeout", "postgres", "harness", "models", "embedding"]);
        expect(Object.keys(document.postgres!)).toEqual(["host", "port", "database", "user", "password"]);
        // `modelPath` is declared between `mode` and `apiKey` but unset here — an absent key is skipped, never emitted as null.
        expect(Object.keys(document.embedding!)).toEqual(["mode", "apiKey", "baseURL", "model", "dimensions"]);
        // `keybinds` is a record and `harness`/`models` cross the schema as `unknown`: no declaration to
        // follow, so their keys are sorted — the only order derivable from the value itself.
        expect(Object.keys(document.keybinds!)).toEqual(["app.abort", "app.command-palette"]);
        expect(Object.keys(document.harness!)).toEqual(["adminPort", "resourceLimits", "sandboxImage"]);
        expect(Object.keys(document.models!)).toEqual(["agents", "connection"]);
    });

    test("a key appended by a spread lands in schema position, not at the end", () => {
        // The concrete defect shape: setup's resource step writes `harness` onto a config parsed without it.
        writeConfig({ telemetry: true, theme: DEFAULT_THEME_ID, leaderTimeout: 2000, embedding: { mode: "off" } })._unsafeUnwrap();
        const appended = writeAndRead({ ...readConfig(), harness: { adminPort: 9000 } });

        expect(Object.keys(JSON.parse(appended) as Record<string, unknown>)).toEqual(["telemetry", "theme", "leaderTimeout", "harness", "embedding"]);
    });
});

describe("readConfig — embedding block", () => {
    test("an apiKey without a mode infers api-key mode (a hand-edited key just works)", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, embedding: { apiKey: "sk-test" } }));
        const { embedding } = readConfig();
        expect(embedding.mode).toBe("api-key");
        expect(embedding.apiKey).toBe("sk-test");
    });

    test("a modelPath without a mode infers local mode", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, embedding: { modelPath: "/models/x.gguf" } }));
        expect(readConfig().embedding.mode).toBe("local");
    });

    test("an explicit off wins over a set apiKey — a deliberate switch-off is honored", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, embedding: { mode: "off", apiKey: "sk-test" } }));
        const { embedding } = readConfig();
        expect(embedding.mode).toBe("off");
        expect(embedding.apiKey).toBe("sk-test"); // kept, so the resolver can name the contradiction
    });

    test("one malformed field degrades alone — it must NOT reset the whole block to off", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, embedding: { mode: "api-key", apiKey: "sk-test", dimensions: "1536" } }));
        const { embedding } = readConfig();
        expect(embedding.mode).toBe("api-key"); // block survived the bad sibling
        expect(embedding.apiKey).toBe("sk-test");
        expect(embedding.dimensions).toBeUndefined(); // only the malformed field was dropped
    });

    test("an unrecognized mode with an apiKey heals to the inferred api-key, not off", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, embedding: { mode: "apikey", apiKey: "sk-test" } }));
        expect(readConfig().embedding.mode).toBe("api-key");
    });

    test("an absent embedding block still defaults to off", () => {
        writeRawConfig(JSON.stringify({ telemetry: false }));
        expect(readConfig().embedding.mode).toBe("off");
    });
});

describe("ensureRuntime", () => {
    function probeReady(readyIds: readonly string[], probed?: string[]) {
        return (rt: ContainerRuntime): Promise<Result<void, ContainerRuntimeError>> => {
            probed?.push(rt.id);
            return Promise.resolve(readyIds.includes(rt.id) ? ok(undefined) : err(new ContainerRuntimeError(rt.notReadyHint)));
        };
    }

    test("an explicit selection is a hard gate — not switched even when the other runtime is ready", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false, runtime: "docker" }));
        const result = await ensureRuntime(probeReady(["podman"]));
        const error = result.match(
            () => null,
            (e) => e,
        );
        expect(error?.message).toContain(runtimes.docker.notReadyHint);
        expect(readConfig().runtime).toBe("docker");
    });

    test("a dead explicit selection names `inflexa setup` as the way to switch runtimes", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false, runtime: "docker" }));
        const result = await ensureRuntime(probeReady(["podman"]));
        const error = result.match(
            () => null,
            (e) => e,
        );
        // The probe's own remediation is preserved AND the switch path is named — the
        // hint must live in ensureRuntime's hard gate, not in setup's fallback.
        expect(error?.message).toContain(runtimes.docker.notReadyHint);
        expect(error?.message).toContain("inflexa setup");
    });

    test("pins the detected runtime and names a discarded unrecognized value", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false, runtime: "podmna" }));
        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]): void => {
            logs.push(args.map((a) => String(a)).join(" "));
        };
        try {
            const result = await ensureRuntime(probeReady(["podman"]));
            expect(result._unsafeUnwrap().id).toBe("podman");
        } finally {
            console.log = originalLog;
        }
        expect(logs.join("\n")).toContain('Ignoring unrecognized runtime "podmna" in config.json');
        expect(logs.join("\n")).toContain(runtimes.podman.label);
        expect(readConfig().runtime).toBe("podman");
    });

    test("a failed pin write aborts — no unpinned proceed", async () => {
        // Force the pin write to fail at the filesystem: a directory AT the config
        // path makes writeConfig's writeFileSync throw EISDIR, so ensureRuntime must
        // abort rather than continue with an unpersisted detection (later steps
        // re-read config and would split one run across two runtimes).
        assertTestSandbox(env.configPath);
        rmSync(env.configPath, { force: true });
        mkdirSync(env.configPath, { recursive: true });
        try {
            const result = await ensureRuntime(probeReady(["podman"]));
            expect(result.isErr()).toBe(true);
            const error = result.match(
                () => null,
                (e) => e,
            );
            expect(error?.message).toContain("saving it as the container runtime failed");
        } finally {
            // Restore fs state: drop the directory so afterEach's file rmSync is a clean no-op.
            assertTestSandbox(env.configPath);
            rmSync(env.configPath, { recursive: true, force: true });
        }
    });

    test("unset: pins the first ready runtime to config", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false }));
        const result = await ensureRuntime(probeReady(["podman"]));
        expect(result._unsafeUnwrap().id).toBe("podman");
        expect(readConfig().runtime).toBe("podman");
    });

    test("unset: probes in registry order, docker first", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false }));
        const probed: string[] = [];
        const result = await ensureRuntime(probeReady(["docker", "podman"], probed));
        expect(result._unsafeUnwrap().id).toBe("docker");
        expect(probed).toEqual(["docker"]);
        expect(readConfig().runtime).toBe("docker");
    });

    test("unset: leaves config unpinned when nothing is ready", async () => {
        writeRawConfig(JSON.stringify({ telemetry: false }));
        const result = await ensureRuntime(probeReady([]));
        expect(result.isErr()).toBe(true);
        expect(readConfig().runtime).toBeUndefined();
    });
});
