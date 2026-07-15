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
        expect(error?.message).toBe(runtimes.docker.notReadyHint);
        expect(readConfig().runtime).toBe("docker");
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
