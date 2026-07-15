import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { ensureMountSources, generateComposeFile, mountManifest, type ConnectionMode } from "./compose.ts";
import { resolvePostgresConfig } from "../../lib/config.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

/**
 * Every absolute host path bound as a volume in a generated compose file. Volume mounts use an absolute
 * host path (`/…:/container/path`); port mappings start with `127.0.0.1`, so the leading-slash filter
 * separates the two without parsing YAML.
 */
function bindMountHosts(yaml: string): string[] {
    const hosts: string[] = [];
    for (const line of yaml.split("\n")) {
        const value = line.match(/^\s*-\s*"([^"]+)"\s*$/)?.[1];
        if (value === undefined) continue;
        const host = value.split(":")[0] ?? "";
        if (host.startsWith("/")) hosts.push(host);
    }
    return hosts;
}

describe("mount manifest coverage", () => {
    const modes: ConnectionMode[] = ["cliproxy", "direct"];
    for (const mode of modes) {
        test(`every bind-mount source in the ${mode} compose file appears in the manifest`, () => {
            const conn = resolvePostgresConfig();
            const hosts = bindMountHosts(generateComposeFile(conn, mode));
            // Guard the extractor itself: a regression that stopped matching volume lines would make this
            // test vacuously pass, so assert it actually found mounts for this mode.
            expect(hosts.length).toBeGreaterThan(0);

            const covered = new Set(mountManifest(mode).map((source) => source.path));
            for (const host of hosts) expect(covered.has(host)).toBe(true);
        });
    }

    test("direct mode lists only the postgres data dir; cliproxy adds the config file + auth dir", () => {
        expect(mountManifest("direct").map((source) => source.path)).toEqual([env.postgresDataDir]);

        const cliproxy = mountManifest("cliproxy");
        expect(cliproxy.find((source) => source.path === env.cliproxyConfigPath)?.kind).toBe("file");
        expect(cliproxy.find((source) => source.path === env.cliproxyAuthDir)?.kind).toBe("directory");
        expect(cliproxy.find((source) => source.path === env.postgresDataDir)?.kind).toBe("directory");
    });
});

// ensureMountSources touches REAL host paths (config file, auth dir, postgres data dir) under the
// mkdtemp sandbox. Guard first (data-loss backstop) and reap them between tests.
describe("ensureMountSources integrity guard", () => {
    const configPath = env.cliproxyConfigPath;
    const cliproxyDir = dirname(configPath);

    function reset(): void {
        assertTestSandbox(cliproxyDir);
        rmSync(cliproxyDir, { recursive: true, force: true });
        assertTestSandbox(env.postgresDataDir);
        rmSync(env.postgresDataDir, { recursive: true, force: true });
    }
    beforeEach(reset);
    afterEach(reset);

    test("cliproxy: the proxy config exists as a FILE (never a directory) before the engine would run", async () => {
        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        // The ordering property: after the guard, the file-typed source is a real file, so a subsequent
        // engine invocation can never manufacture a directory at its path. Verified at the seam rather
        // than by spawning a real engine.
        expect(statSync(configPath).isFile()).toBe(true);
        expect(statSync(env.cliproxyAuthDir).isDirectory()).toBe(true);
        expect(statSync(env.postgresDataDir).isDirectory()).toBe(true);
    });

    test("direct: only the postgres data dir is created; no proxy config is written", async () => {
        (await ensureMountSources("direct"))._unsafeUnwrap();
        expect(statSync(env.postgresDataDir).isDirectory()).toBe(true);
        expect(existsSync(configPath)).toBe(false);
    });

    test("heals an empty directory manufactured at the config path", async () => {
        mkdirSync(configPath, { recursive: true });
        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        expect(statSync(configPath).isFile()).toBe(true);
    });

    test("refuses a non-empty occupant with a typed path_occupied error, deleting nothing", async () => {
        mkdirSync(configPath, { recursive: true });
        writeFileSync(join(configPath, "keep.txt"), "precious");

        const error = (await ensureMountSources("cliproxy"))._unsafeUnwrapErr();
        expect(error.type).toBe("path_occupied");
        expect(statSync(configPath).isDirectory()).toBe(true);
        expect(readFileSync(join(configPath, "keep.txt"), "utf8")).toBe("precious");
    });

    test("is a no-op on already-healthy state: a second run changes nothing", async () => {
        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        const before = readFileSync(configPath, "utf8");

        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });
});
