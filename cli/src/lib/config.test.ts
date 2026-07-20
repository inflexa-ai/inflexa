import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
