import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readConfig, writeConfig, type Config } from "./config.ts";
import { DEFAULT_THEME_ID } from "./design_system.ts";
import { env } from "./env.ts";

// Drives config through the public readConfig/writeConfig surface against the sandboxed
// env.configPath (set by the test preload), so it exercises the real fail-closed + self-healing
// paths rather than poking the private schema.

function writeRawConfig(json: string): void {
    mkdirSync(dirname(env.configPath), { recursive: true });
    writeFileSync(env.configPath, json);
}

afterEach(() => {
    rmSync(env.configPath, { force: true });
});

describe("readConfig — self-healing fields", () => {
    test("coerces an invalid theme to the default, keeping the other fields", () => {
        writeRawConfig(JSON.stringify({ telemetry: true, theme: "no-such-theme" }));
        const cfg = readConfig();
        expect(cfg.theme).toBe(DEFAULT_THEME_ID);
        expect(cfg.telemetry).toBe(true);
    });

    test("coerces an invalid runtime to docker", () => {
        writeRawConfig(JSON.stringify({ telemetry: false, runtime: "kubernetes" }));
        expect(readConfig().runtime).toBe("docker");
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
});

describe("writeConfig / readConfig round-trip", () => {
    test("a written config reads back identically", () => {
        const cfg: Config = { telemetry: true, theme: DEFAULT_THEME_ID, runtime: "podman", leaderTimeout: 500 };
        writeConfig(cfg)._unsafeUnwrap();
        expect(readConfig()).toEqual(cfg);
    });
});
