import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ok, err } from "neverthrow";

import * as compose from "./compose.ts";
import {
    POSTGRES_CONTAINER_NAME,
    POSTGRES_VOLUME_NAME,
    PROXY_CONTAINER_NAME,
    ensureMountSources,
    generateComposeFile,
    mountManifest,
    postgresDataLocation,
    removePostgresVolume,
    writeComposeFile,
    type ComposeHost,
    type ConnectionMode,
} from "./compose.ts";
import { up } from "./lifecycle.ts";
import { ensurePostgresReady } from "./postgres.ts";
import * as config from "../../lib/config.ts";
import { resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import { runtimes } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

/**
 * Every absolute host path bound as a volume in a generated compose file, read back as the YAML parser
 * would give it. A volume scalar is `"<host>:<container>"`. The container path is absolute and holds no
 * `:`, so the LAST `:/` splits the two — a drive letter (`C:\`) never matches it, and a port mapping
 * (`127.0.0.1:8432:5432`) has none. The scalar is matched up to the last `"` of the line, because an
 * escaped quotation mark can sit inside it. A named volume's source is a bare name, not an absolute
 * path, so the final filter drops it: a named volume is not a bind mount.
 */
function bindMountHosts(yaml: string): string[] {
    const hosts: string[] = [];
    for (const line of yaml.split("\n")) {
        const value = line.match(/^\s*-\s*"(.*)"\s*$/)?.[1];
        if (value === undefined) continue;
        const split = value.lastIndexOf(":/");
        if (split === -1) continue;
        // Undo escapeYaml's two escapes in one left-to-right pass, as a YAML parser does.
        const host = value.slice(0, split).replace(/\\(["\\])/g, "$1");
        if (host.startsWith("/") || /^[A-Za-z]:\\/.test(host)) hosts.push(host);
    }
    return hosts;
}

// No maintainer has a Windows host, so every Windows branch is proven through the ComposeHost seam. The
// paths are the shape `%LOCALAPPDATA%\inflexa\…` takes — the shape issue #560 was reported with.
const windowsHost: ComposeHost = {
    platform: "win32",
    cliproxyConfigPath: String.raw`C:\Users\dana\AppData\Local\inflexa\cliproxy\config.yaml`,
    cliproxyAuthDir: String.raw`C:\Users\dana\AppData\Local\inflexa\cliproxy\auth`,
    postgresDataDir: String.raw`C:\Users\dana\AppData\Local\inflexa\postgres`,
};

// A quotation mark is legal in a POSIX path (and illegal in a Windows one), so the `"` escape is proven
// on a linux host.
const quotedPosixHost: ComposeHost = {
    platform: "linux",
    cliproxyConfigPath: '/home/da"na/.local/share/inflexa/cliproxy/config.yaml',
    cliproxyAuthDir: '/home/da"na/.local/share/inflexa/cliproxy/auth',
    postgresDataDir: '/home/da"na/.local/share/inflexa/postgres',
};

describe("host paths in the compose file", () => {
    test("a Windows path has every backslash doubled, and reads back as the exact path", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy", windowsHost);
        expect(yaml).toContain(String.raw`- "C:\\Users\\dana\\AppData\\Local\\inflexa\\cliproxy\\config.yaml:/CLIProxyAPI/config.yaml"`);
        expect(yaml).toContain(String.raw`- "C:\\Users\\dana\\AppData\\Local\\inflexa\\cliproxy\\auth:/root/.cli-proxy-api"`);
        // No raw single backslash survives: `\U` is the escape that made the compose tool reject the file.
        expect(yaml).not.toMatch(/[^\\]\\U/);
        expect(bindMountHosts(yaml)).toEqual([windowsHost.cliproxyConfigPath, windowsHost.cliproxyAuthDir]);
    });

    test("a quotation mark in a path is escaped, and reads back as the exact path", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy", quotedPosixHost);
        expect(yaml).toContain(String.raw`- "/home/da\"na/.local/share/inflexa/postgres:/var/lib/postgresql"`);
        expect(bindMountHosts(yaml)).toEqual([quotedPosixHost.cliproxyConfigPath, quotedPosixHost.cliproxyAuthDir, quotedPosixHost.postgresDataDir]);
    });

    test("a path with no backslash and no quotation mark is written as it is", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy");
        expect(yaml).toContain(`      - "${env.cliproxyConfigPath}:/CLIProxyAPI/config.yaml"\n`);
        expect(yaml).toContain(`      - "${env.cliproxyAuthDir}:/root/.cli-proxy-api"\n`);
        expect(yaml).toContain(`      - "${env.postgresDataDir}:/var/lib/postgresql"\n`);
    });
});

describe("Postgres data location", () => {
    const modes: ConnectionMode[] = ["cliproxy", "direct"];

    test("win32 persists into the named volume; every other platform bind-mounts the data dir", () => {
        expect(postgresDataLocation(windowsHost)).toEqual({ kind: "volume", name: POSTGRES_VOLUME_NAME });
        for (const platform of ["darwin", "linux"] as const) {
            expect(postgresDataLocation({ ...quotedPosixHost, platform })).toEqual({ kind: "bind", path: quotedPosixHost.postgresDataDir });
        }
    });

    test("the volume name is channel-aware, through the same prefix as the container name", () => {
        expect(POSTGRES_VOLUME_NAME).toBe(`${POSTGRES_CONTAINER_NAME}-data`);
    });

    for (const mode of modes) {
        test(`${mode}: a Windows host mounts the named volume and declares it with an explicit name`, () => {
            const yaml = generateComposeFile(resolvePostgresConfig(), mode, windowsHost);
            expect(yaml).toContain(`      - "${POSTGRES_VOLUME_NAME}:/var/lib/postgresql"\n`);
            expect(yaml).toContain(`\nvolumes:\n  ${POSTGRES_VOLUME_NAME}:\n    name: ${POSTGRES_VOLUME_NAME}\n`);
            // The data directory is mounted nowhere — neither raw nor escaped.
            expect(yaml).not.toContain(windowsHost.postgresDataDir);
            expect(yaml).not.toContain(windowsHost.postgresDataDir.replaceAll("\\", "\\\\"));
        });

        for (const platform of ["darwin", "linux"] as const) {
            test(`${mode}: a ${platform} host has no top-level volumes block`, () => {
                const yaml = generateComposeFile(resolvePostgresConfig(), mode, { ...quotedPosixHost, platform });
                // Service-level `volumes:` keys are indented, so a line-start match sees only the top level.
                expect(yaml).not.toMatch(/^volumes:/m);
            });
        }
    }
});

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

    // A named volume is not a mount source, so on a Windows host the manifest lists no Postgres data dir.
    test("a Windows host: every bind mount of the cliproxy file is in the manifest, and nothing else is", () => {
        const hosts = bindMountHosts(generateComposeFile(resolvePostgresConfig(), "cliproxy", windowsHost));
        expect(hosts.length).toBe(2);
        expect(mountManifest("cliproxy", windowsHost).map((source) => source.path)).toEqual(hosts);
    });

    test("a Windows host in direct mode has no bind mount and an empty manifest", () => {
        expect(bindMountHosts(generateComposeFile(resolvePostgresConfig(), "direct", windowsHost))).toEqual([]);
        expect(mountManifest("direct", windowsHost)).toEqual([]);
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

    test("win32: the guard makes no Postgres data dir, because a named volume holds the data", async () => {
        // The sandboxed POSIX path with the win32 platform: a Windows path string here would be a
        // relative name on this host, and a wrong guard would then litter the working directory.
        (await ensureMountSources("direct", { ...windowsHost, postgresDataDir: env.postgresDataDir }))._unsafeUnwrap();
        expect(existsSync(env.postgresDataDir)).toBe(false);
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
        // The guard propagates the occupant kind so the message can name it (a non-empty directory here).
        if (error.type === "path_occupied") expect(error.occupant).toBe("non_empty_directory");
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

// writeComposeFile writes the REAL env.composeFilePath (sandboxed under the test preload). Guard first
// (data-loss backstop) and reap it between tests.
describe("compose regeneration on mode drift", () => {
    const composeFilePath = env.composeFilePath;

    function reset(): void {
        assertTestSandbox(composeFilePath);
        rmSync(composeFilePath, { force: true });
    }
    beforeEach(reset);
    afterEach(reset);

    // Every compose entry point (`up`, `ensurePostgresReady`, `ensureProxyReady`, setup) regenerates the
    // file from current config via writeComposeFile before the mount-source guard runs, so an on-disk file
    // left under an earlier mode is always overwritten for the current mode — the guard and the executed
    // file cannot drift. These assert the regenerate (not write-if-missing) semantics directly: a
    // stale-mode file present on disk is rewritten for the mode the entry point resolves now.
    test("a cliproxy file on disk is regenerated for direct mode before the guard would run", () => {
        const conn = resolvePostgresConfig();
        writeComposeFile(conn, "cliproxy")._unsafeUnwrap();
        expect(readFileSync(composeFilePath, "utf8")).toContain(`${PROXY_CONTAINER_NAME}:`);

        writeComposeFile(conn, "direct")._unsafeUnwrap();
        const regenerated = readFileSync(composeFilePath, "utf8");
        expect(regenerated).not.toContain(`${PROXY_CONTAINER_NAME}:`);
        // The proxy image and its file-typed config mount vanish with the service, matching direct's manifest.
        expect(regenerated).not.toContain("cli-proxy-api");
        expect(regenerated).toContain(`${POSTGRES_CONTAINER_NAME}:`);
    });

    test("a direct file on disk is regenerated for cliproxy mode before the guard would run", () => {
        const conn = resolvePostgresConfig();
        writeComposeFile(conn, "direct")._unsafeUnwrap();
        expect(readFileSync(composeFilePath, "utf8")).not.toContain(`${PROXY_CONTAINER_NAME}:`);

        writeComposeFile(conn, "cliproxy")._unsafeUnwrap();
        const regenerated = readFileSync(composeFilePath, "utf8");
        expect(regenerated).toContain(`${PROXY_CONTAINER_NAME}:`);
        expect(regenerated).toContain(`${POSTGRES_CONTAINER_NAME}:`);
    });
});

// The block above proves writeComposeFile's regenerate semantics in isolation; these prove the two
// launch-time entry points actually WIRE that regeneration in — rewriting the compose file for the
// current mode before they hand off to composeUp. The regression they guard is a "write-if-missing"
// reintroduction, where a stale-mode file left on disk would survive and the engine would execute the
// wrong service set. Driven with cross-module spies (Bun's spyOn on a module namespace intercepts an
// importer's call) on the runtime gate and the engine steps, so no real container runtime is spawned;
// writeComposeFile runs for real and the composeUp spy captures the on-disk file at the hand-off point.
describe("entry-point compose regeneration wiring", () => {
    const composeFilePath = env.composeFilePath;
    const spies: { mockRestore: () => void }[] = [];

    function reset(): void {
        assertTestSandbox(composeFilePath);
        rmSync(composeFilePath, { force: true });
    }
    beforeEach(reset);
    afterEach(() => {
        for (const s of spies) s.mockRestore();
        spies.length = 0;
        reset();
    });

    function hasProxyService(yaml: string): boolean {
        return yaml.includes(`${PROXY_CONTAINER_NAME}:`);
    }

    // Seed the compose file for the OPPOSITE of the mode config resolves now, so the assertion is
    // independent of what the test env resolves to: the proxy service is present iff mode is cliproxy.
    function seedStaleComposeFile(): { currentMode: ConnectionMode; staleMode: ConnectionMode } {
        const currentMode = resolveConnectionMode();
        const staleMode: ConnectionMode = currentMode === "cliproxy" ? "direct" : "cliproxy";
        writeComposeFile(resolvePostgresConfig(), staleMode)._unsafeUnwrap();
        expect(hasProxyService(readFileSync(composeFilePath, "utf8"))).toBe(staleMode === "cliproxy");
        return { currentMode, staleMode };
    }

    test("`up` regenerates the compose file for the current mode before composeUp", async () => {
        const { currentMode } = seedStaleComposeFile();

        // mockImplementation (not mockResolvedValue) so each `ok(...)`/`err(...)` is a RETURNED Result the
        // neverthrow lint counts as handled, rather than an unconsumed Result passed as an argument.
        spies.push(spyOn(config, "ensureRuntime").mockImplementation(async () => ok(runtimes.docker)));
        spies.push(spyOn(compose, "composeAvailable").mockResolvedValue(true));
        spies.push(spyOn(compose, "composePullIfMissing").mockImplementation(async () => ok(undefined)));
        let composeAtHandoff = "";
        spies.push(
            spyOn(compose, "composeUp").mockImplementation(async () => {
                composeAtHandoff = readFileSync(composeFilePath, "utf8");
                return ok(undefined);
            }),
        );

        await up();

        // The stale opposite-mode file was overwritten for the current mode before the engine hand-off.
        expect(hasProxyService(composeAtHandoff)).toBe(currentMode === "cliproxy");
    });

    test("`ensurePostgresReady` regenerates the compose file for the current mode before composeUp", async () => {
        const { currentMode } = seedStaleComposeFile();

        spies.push(spyOn(config, "ensureRuntime").mockImplementation(async () => ok(runtimes.docker)));
        let composeAtHandoff = "";
        spies.push(
            spyOn(compose, "composeUp").mockImplementation(async () => {
                composeAtHandoff = readFileSync(composeFilePath, "utf8");
                // Error return short-circuits the gate before waitForReady/ensureVectorExtension (which
                // would spawn real docker); ensurePostgresReady sets no process.exitCode of its own.
                return err({ type: "container_start_failed", message: "stub: short-circuit after compose file capture" });
            }),
        );

        (await ensurePostgresReady())._unsafeUnwrapErr();

        expect(hasProxyService(composeAtHandoff)).toBe(currentMode === "cliproxy");
    });
});

// The engine's `name=` filter matches substrings, so the parsing must demand an exact line match —
// otherwise any container whose name merely CONTAINS the proxy's would count as the proxy running
// and trigger a restart of a container that never served the stale credential.
describe("composeProxyRunning", () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    function stubPs(result: { code: number; stdout: string; stderr: string }): void {
        spies.push(spyOn(container, "capture").mockImplementation(async () => result));
    }

    test("an exact name line reads as running", async () => {
        stubPs({ code: 0, stdout: `${PROXY_CONTAINER_NAME}\n`, stderr: "" });
        expect((await compose.composeProxyRunning(runtimes.docker))._unsafeUnwrap()).toBe(true);
    });

    test("a superset name is NOT the proxy — the engine filter is substring, the verdict must not be", async () => {
        stubPs({ code: 0, stdout: `${PROXY_CONTAINER_NAME}-login\n`, stderr: "" });
        expect((await compose.composeProxyRunning(runtimes.docker))._unsafeUnwrap()).toBe(false);
    });

    test("no matching container reads as not running", async () => {
        stubPs({ code: 0, stdout: "\n", stderr: "" });
        expect((await compose.composeProxyRunning(runtimes.docker))._unsafeUnwrap()).toBe(false);
    });

    test("an engine failure is an error, not a verdict", async () => {
        stubPs({ code: 1, stderr: "cannot connect to the daemon", stdout: "" });
        expect((await compose.composeProxyRunning(runtimes.docker)).isErr()).toBe(true);
    });
});

// `inflexa down --delete-data` calls this on EVERY platform, so the absent branch is the common one: a
// host that is not Windows never has the volume.
describe("removePostgresVolume", () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    /** Script `capture` by subcommand (`volume inspect` / `volume rm`) and record every call's args. */
    function stubVolume(exits: { inspect: number; rm: number; rmStderr?: string }): string[][] {
        const calls: string[][] = [];
        spies.push(
            spyOn(container, "capture").mockImplementation(async (_rt, args) => {
                calls.push(args);
                return args[1] === "inspect" ? { code: exits.inspect, stdout: "", stderr: "" } : { code: exits.rm, stdout: "", stderr: exits.rmStderr ?? "" };
            }),
        );
        return calls;
    }

    test("an absent volume is ok, and no removal is attempted", async () => {
        const calls = stubVolume({ inspect: 1, rm: 0 });
        expect((await removePostgresVolume(runtimes.docker))._unsafeUnwrap()).toBe("absent");
        expect(calls).toEqual([["volume", "inspect", POSTGRES_VOLUME_NAME]]);
    });

    test("a present volume is removed by its explicit name, through the engine", async () => {
        const calls = stubVolume({ inspect: 0, rm: 0 });
        expect((await removePostgresVolume(runtimes.podman))._unsafeUnwrap()).toBe("removed");
        expect(calls).toEqual([
            ["volume", "inspect", POSTGRES_VOLUME_NAME],
            ["volume", "rm", POSTGRES_VOLUME_NAME],
        ]);
    });

    test("an engine refusal is a typed error that carries the engine's text", async () => {
        stubVolume({ inspect: 0, rm: 1, rmStderr: "volume is in use\n" });
        const error = (await removePostgresVolume(runtimes.docker))._unsafeUnwrapErr();
        expect(error.type).toBe("volume_remove_failed");
        expect(error.message).toContain("volume is in use");
        expect(error.message).toContain(`docker volume rm ${POSTGRES_VOLUME_NAME}`);
    });
});
