import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ok, err } from "neverthrow";

import * as compose from "./compose.ts";
import {
    POSTGRES_CONTAINER_NAME,
    PROXY_IMAGE,
    SEARXNG_CONTAINER_NAME,
    SEARXNG_IMAGE,
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
import { DEFAULT_IMAGE } from "./postgres_types.ts";
import * as config from "../../lib/config.ts";
import { resolveConnectionMode, resolvePostgresConfig } from "../../lib/config.ts";
import * as container from "../../lib/container.ts";
import { runtimes, type EnginePullOutcome, type EnginePullProgress } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import type { BootPullProgress } from "../../api/server.ts";

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
    searxngSettingsPath: String.raw`C:\Users\dana\AppData\Local\inflexa\searxng\settings.yml`,
};

// A quotation mark is legal in a POSIX path (and illegal in a Windows one), so the `"` escape is proven
// on a linux host.
const quotedPosixHost: ComposeHost = {
    platform: "linux",
    cliproxyConfigPath: '/home/da"na/.local/share/inflexa/cliproxy/config.yaml',
    cliproxyAuthDir: '/home/da"na/.local/share/inflexa/cliproxy/auth',
    postgresDataDir: '/home/da"na/.local/share/inflexa/postgres',
    searxngSettingsPath: '/home/da"na/.local/share/inflexa/searxng/settings.yml',
};

describe("host paths in the compose file", () => {
    test("a Windows path has every backslash doubled, and reads back as the exact path", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy", windowsHost);
        expect(yaml).toContain(String.raw`- "C:\\Users\\dana\\AppData\\Local\\inflexa\\cliproxy\\config.yaml:/CLIProxyAPI/config.yaml"`);
        expect(yaml).toContain(String.raw`- "C:\\Users\\dana\\AppData\\Local\\inflexa\\cliproxy\\auth:/root/.cli-proxy-api"`);
        expect(yaml).toContain(String.raw`- "C:\\Users\\dana\\AppData\\Local\\inflexa\\searxng\\settings.yml:/etc/searxng/settings.yml:ro"`);
        // No raw single backslash survives: `\U` is the escape that made the compose tool reject the file.
        expect(yaml).not.toMatch(/[^\\]\\U/);
        expect(bindMountHosts(yaml)).toEqual([windowsHost.cliproxyConfigPath, windowsHost.cliproxyAuthDir, windowsHost.searxngSettingsPath]);
    });

    test("a quotation mark in a path is escaped, and reads back as the exact path", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy", quotedPosixHost);
        expect(yaml).toContain(String.raw`- "/home/da\"na/.local/share/inflexa/postgres:/var/lib/postgresql"`);
        expect(yaml).toContain(String.raw`- "/home/da\"na/.local/share/inflexa/searxng/settings.yml:/etc/searxng/settings.yml:ro"`);
        expect(bindMountHosts(yaml)).toEqual([
            quotedPosixHost.cliproxyConfigPath,
            quotedPosixHost.cliproxyAuthDir,
            quotedPosixHost.postgresDataDir,
            quotedPosixHost.searxngSettingsPath,
        ]);
    });

    test("a path with no backslash and no quotation mark is written as it is", () => {
        const yaml = generateComposeFile(resolvePostgresConfig(), "cliproxy");
        expect(yaml).toContain(`      - "${env.cliproxyConfigPath}:/CLIProxyAPI/config.yaml"\n`);
        expect(yaml).toContain(`      - "${env.cliproxyAuthDir}:/root/.cli-proxy-api"\n`);
        expect(yaml).toContain(`      - "${env.postgresDataDir}:/var/lib/postgresql"\n`);
        expect(yaml).toContain(`      - "${env.searxngSettingsPath}:/etc/searxng/settings.yml:ro"\n`);
    });
});

describe("the SearXNG service", () => {
    const modes: ConnectionMode[] = ["cliproxy", "direct"];
    for (const mode of modes) {
        test(`${mode}: defined with the pinned image, the loopback-only port, and the read-only settings mount`, () => {
            const yaml = generateComposeFile(resolvePostgresConfig(), mode);
            expect(yaml).toContain(`  ${SEARXNG_CONTAINER_NAME}:`);
            expect(yaml).toContain(`container_name: ${SEARXNG_CONTAINER_NAME}`);
            // The pin literal itself, then its dated-tag + digest FORM: never a floating tag.
            expect(yaml).toContain(`image: ${SEARXNG_IMAGE}`);
            expect(yaml).toMatch(/image: docker\.io\/searxng\/searxng:\d{4}\.\d{2}\.\d{2}-[0-9a-f]+@sha256:[0-9a-f]{64}\n/);
            expect(yaml).toContain(`"127.0.0.1:${env.searxngPort}:8080"`);
            expect(yaml).toContain(`"${env.searxngSettingsPath}:/etc/searxng/settings.yml:ro"`);
            expect(yaml).toContain("restart: unless-stopped");
        });
    }
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

    test("direct mode lists the postgres data dir and the searxng settings file; cliproxy adds the config file + auth dir", () => {
        const direct = mountManifest("direct");
        expect(direct.map((source) => source.path)).toEqual([env.postgresDataDir, env.searxngSettingsPath]);
        expect(direct.find((source) => source.path === env.searxngSettingsPath)?.kind).toBe("file");

        const cliproxy = mountManifest("cliproxy");
        expect(cliproxy.find((source) => source.path === env.cliproxyConfigPath)?.kind).toBe("file");
        expect(cliproxy.find((source) => source.path === env.cliproxyAuthDir)?.kind).toBe("directory");
        expect(cliproxy.find((source) => source.path === env.postgresDataDir)?.kind).toBe("directory");
        expect(cliproxy.find((source) => source.path === env.searxngSettingsPath)?.kind).toBe("file");
    });

    // A named volume is not a mount source, so on a Windows host the manifest lists no Postgres data dir.
    test("a Windows host: every bind mount of the cliproxy file is in the manifest, and nothing else is", () => {
        const hosts = bindMountHosts(generateComposeFile(resolvePostgresConfig(), "cliproxy", windowsHost));
        expect(hosts.length).toBe(3);
        expect(mountManifest("cliproxy", windowsHost).map((source) => source.path)).toEqual(hosts);
    });

    test("a Windows host in direct mode mounts only the settings file, and the manifest covers exactly it", () => {
        const hosts = bindMountHosts(generateComposeFile(resolvePostgresConfig(), "direct", windowsHost));
        expect(hosts).toEqual([windowsHost.searxngSettingsPath]);
        const manifest = mountManifest("direct", windowsHost);
        expect(manifest.map((source) => source.path)).toEqual(hosts);
        expect(manifest[0]?.kind).toBe("file");
    });
});

// ensureMountSources touches REAL host paths (config file, auth dir, postgres data dir, searxng settings)
// under the mkdtemp sandbox. Guard first (data-loss backstop) and reap them between tests.
describe("ensureMountSources integrity guard", () => {
    const configPath = env.cliproxyConfigPath;
    const cliproxyDir = dirname(configPath);
    const searxngDir = dirname(env.searxngSettingsPath);

    function reset(): void {
        assertTestSandbox(cliproxyDir);
        rmSync(cliproxyDir, { recursive: true, force: true });
        assertTestSandbox(searxngDir);
        rmSync(searxngDir, { recursive: true, force: true });
        assertTestSandbox(env.postgresDataDir);
        rmSync(env.postgresDataDir, { recursive: true, force: true });
    }
    beforeEach(reset);
    afterEach(reset);

    test("cliproxy: the proxy config and the searxng settings exist as FILES (never directories) before the engine would run", async () => {
        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        // The ordering property: after the guard, the file-typed sources are real files, so a subsequent
        // engine invocation can never manufacture a directory at their paths. Verified at the seam rather
        // than by spawning a real engine.
        expect(statSync(configPath).isFile()).toBe(true);
        expect(statSync(env.searxngSettingsPath).isFile()).toBe(true);
        expect(statSync(env.cliproxyAuthDir).isDirectory()).toBe(true);
        expect(statSync(env.postgresDataDir).isDirectory()).toBe(true);
    });

    test("direct: the postgres data dir and the searxng settings file are provisioned; no proxy config is written", async () => {
        (await ensureMountSources("direct"))._unsafeUnwrap();
        expect(statSync(env.postgresDataDir).isDirectory()).toBe(true);
        expect(statSync(env.searxngSettingsPath).isFile()).toBe(true);
        expect(existsSync(configPath)).toBe(false);
    });

    test("win32: the guard makes no Postgres data dir, because a named volume holds the data", async () => {
        // The sandboxed POSIX paths with the win32 platform: a Windows path string here would be a
        // relative name on this host, and a wrong guard would then litter the working directory.
        (
            await ensureMountSources("direct", { ...windowsHost, postgresDataDir: env.postgresDataDir, searxngSettingsPath: env.searxngSettingsPath })
        )._unsafeUnwrap();
        expect(existsSync(env.postgresDataDir)).toBe(false);
    });

    test("heals an empty directory manufactured at the config path", async () => {
        mkdirSync(configPath, { recursive: true });
        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        expect(statSync(configPath).isFile()).toBe(true);
    });

    test("heals an empty directory manufactured at the searxng settings path", async () => {
        mkdirSync(env.searxngSettingsPath, { recursive: true });
        (await ensureMountSources("direct"))._unsafeUnwrap();
        expect(statSync(env.searxngSettingsPath).isFile()).toBe(true);
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
        const settingsBefore = readFileSync(env.searxngSettingsPath, "utf8");

        (await ensureMountSources("cliproxy"))._unsafeUnwrap();
        expect(readFileSync(configPath, "utf8")).toBe(before);
        expect(readFileSync(env.searxngSettingsPath, "utf8")).toBe(settingsBefore);
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
        // `up` runs the login gate of `ensureProxyReady` before the compose steps. A staged credential passes it
        // with no prompt, and the proxy config that the gate writes is removed with the credential.
        const credentialPath = join(env.cliproxyAuthDir, "compose-test.json");
        const configExisted = existsSync(env.cliproxyConfigPath);
        assertTestSandbox(credentialPath);
        assertTestSandbox(env.cliproxyConfigPath);
        mkdirSync(env.cliproxyAuthDir, { recursive: true });
        writeFileSync(credentialPath, JSON.stringify({ type: "gemini" }));

        // mockImplementation (not mockResolvedValue) so each `ok(...)`/`err(...)` is a RETURNED Result the
        // neverthrow lint counts as handled, rather than an unconsumed Result passed as an argument.
        spies.push(spyOn(config, "ensureRuntime").mockImplementation(async () => ok(runtimes.docker)));
        spies.push(spyOn(compose, "composeAvailable").mockResolvedValue(true));
        spies.push(spyOn(compose, "composePullIfMissing").mockImplementation(async () => ok(undefined)));
        spies.push(spyOn(compose, "composeProxyRunning").mockImplementation(async () => ok(false)));
        let composeAtHandoff = "";
        spies.push(
            spyOn(compose, "composeUp").mockImplementation(async () => {
                composeAtHandoff = readFileSync(composeFilePath, "utf8");
                // An error ends the gate before the credential probe, which would wait on a proxy that no test runs.
                return err({ type: "container_start_failed", message: "stub: short-circuit after compose file capture" });
            }),
        );

        try {
            expect(await up()).toBe(false);
        } finally {
            rmSync(credentialPath, { force: true });
            if (!configExisted) rmSync(env.cliproxyConfigPath, { force: true });
        }

        // The stale opposite-mode file was overwritten for the current mode before the engine hand-off.
        expect(composeAtHandoff).not.toBe("");
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

describe("composePullIfMissing", () => {
    const spies: Array<{ mockRestore: () => void }> = [];
    afterEach(() => {
        for (const spy of spies.splice(0)) spy.mockRestore();
    });

    type Pull = { reports?: number[]; outcome?: EnginePullOutcome };

    /**
     * Script the engine. `held` lists the images the engine holds before the pull. A pull that completes adds its
     * image to the engine unless `holdsAfterPull` is false. `socket` is the resolved engine socket.
     */
    function script(opts: { held?: string[]; socket?: string; holdsAfterPull?: boolean; sizes?: Record<string, number | null>; pulls?: Record<string, Pull> }) {
        const held = new Set(opts.held ?? []);
        const inherited: string[][] = [];
        const pulled: Array<{ socket: string; image: string }> = [];
        const logs: string[] = [];
        spies.push(
            spyOn(container, "capture").mockImplementation(async (_rt, args) => ({ code: held.has(args[2] ?? "") ? 0 : 1, stdout: "", stderr: "" })),
            spyOn(container, "inherit").mockImplementation(async (_rt, args) => {
                inherited.push(args);
                return 0;
            }),
            spyOn(container, "resolveEngineApiSocket").mockImplementation(async () => opts.socket),
            spyOn(container, "resolveImageTotalBytes").mockImplementation(async (_rt, image) => opts.sizes?.[image] ?? null),
            spyOn(container, "pullImageThroughEngine").mockImplementation(async (socket, image, onProgress) => {
                pulled.push({ socket, image });
                const pull = opts.pulls?.[image] ?? {};
                for (const doneBytes of pull.reports ?? []) onProgress({ doneBytes, layersCompleted: 0 } satisfies EnginePullProgress);
                const outcome = pull.outcome ?? { kind: "completed" };
                if (outcome.kind === "completed" && opts.holdsAfterPull !== false) held.add(image);
                return outcome;
            }),
            spyOn(console, "log").mockImplementation((line: unknown) => {
                logs.push(String(line));
            }),
        );
        return { inherited, pulled, logs };
    }

    test("nothing is missing: no pull, no line, no report", async () => {
        const run = script({ held: [PROXY_IMAGE, SEARXNG_IMAGE, DEFAULT_IMAGE], socket: "/engine.sock" });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.podman, "cliproxy", (p) => reports.push(p))).isOk()).toBe(true);

        expect(run.pulled).toEqual([]);
        expect(run.inherited).toEqual([]);
        expect(run.logs).toEqual([]);
        expect(reports).toEqual([]);
    });

    test("no socket path pulls with `compose pull` and reports no progress", async () => {
        const run = script({ socket: undefined });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.docker, "direct", (p) => reports.push(p))).isOk()).toBe(true);

        expect(run.pulled).toEqual([]);
        expect(run.inherited).toHaveLength(1);
        expect(run.inherited[0]).toContain("compose");
        expect(run.inherited[0]?.at(-1)).toBe("pull");
        expect(reports).toEqual([]);
    });

    test("a socket path pulls each missing image through the engine and reports the summed bytes with the summed total", async () => {
        const run = script({
            socket: "/engine.sock",
            held: [],
            sizes: { [PROXY_IMAGE]: 100, [SEARXNG_IMAGE]: 50, [DEFAULT_IMAGE]: 200 },
            pulls: { [PROXY_IMAGE]: { reports: [30] }, [DEFAULT_IMAGE]: { reports: [50, 120] } },
        });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.podman, "cliproxy", (p) => reports.push(p))).isOk()).toBe(true);

        expect(run.pulled).toEqual([
            { socket: "/engine.sock", image: PROXY_IMAGE },
            { socket: "/engine.sock", image: SEARXNG_IMAGE },
            { socket: "/engine.sock", image: DEFAULT_IMAGE },
        ]);
        expect(run.inherited).toEqual([]);
        expect(reports).toEqual([
            { doneBytes: 30, totalBytes: 350 },
            { doneBytes: 80, totalBytes: 350 },
            { doneBytes: 150, totalBytes: 350 },
        ]);
    });

    test("only the missing image pulls", async () => {
        const run = script({ socket: "/engine.sock", held: [PROXY_IMAGE, SEARXNG_IMAGE] });

        expect((await compose.composePullIfMissing(runtimes.podman, "cliproxy", () => undefined)).isOk()).toBe(true);

        expect(run.pulled.map((p) => p.image)).toEqual([DEFAULT_IMAGE]);
    });

    test("a report of 0 bytes gives no call of onProgress", async () => {
        script({ socket: "/engine.sock", pulls: { [DEFAULT_IMAGE]: { reports: [0, 0] } } });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.podman, "direct", (p) => reports.push(p))).isOk()).toBe(true);

        expect(reports).toEqual([]);
    });

    test("an unknown size gives totalBytes null", async () => {
        script({
            socket: "/engine.sock",
            sizes: { [PROXY_IMAGE]: 100, [DEFAULT_IMAGE]: null },
            pulls: { [PROXY_IMAGE]: { reports: [10] } },
        });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.podman, "cliproxy", (p) => reports.push(p))).isOk()).toBe(true);

        expect(reports).toEqual([{ doneBytes: 10, totalBytes: null }]);
    });

    test("a failed pull gives image_pull_failed with the image and the message of the engine, and no compose pull", async () => {
        const run = script({
            socket: "/engine.sock",
            pulls: { [DEFAULT_IMAGE]: { outcome: { kind: "failed", message: "manifest unknown" } } },
        });

        const error = (await compose.composePullIfMissing(runtimes.podman, "cliproxy", () => undefined))._unsafeUnwrapErr();

        expect(error.type).toBe("image_pull_failed");
        expect(error.type === "image_pull_failed" ? error.image : "").toBe(DEFAULT_IMAGE);
        expect(error.message).toContain("manifest unknown");
        // All three pulls settled before the outcome was read.
        expect(run.pulled).toHaveLength(3);
        expect(run.inherited).toEqual([]);
    });

    test("an unavailable pull pulls with `compose pull`", async () => {
        const run = script({ socket: "/engine.sock", pulls: { [DEFAULT_IMAGE]: { outcome: { kind: "unavailable" } } } });

        expect((await compose.composePullIfMissing(runtimes.podman, "direct", () => undefined)).isOk()).toBe(true);

        expect(run.inherited).toHaveLength(1);
        expect(run.inherited[0]?.at(-1)).toBe("pull");
    });

    test("a completed pull whose image the engine does not hold pulls with `compose pull`", async () => {
        const run = script({ socket: "/engine.sock", holdsAfterPull: false });
        const reports: BootPullProgress[] = [];

        expect((await compose.composePullIfMissing(runtimes.podman, "direct", (p) => reports.push(p))).isOk()).toBe(true);

        expect(run.pulled).toHaveLength(2);
        expect(run.inherited).toHaveLength(1);
        expect(reports).toEqual([]);
    });

    test("writes a start line and an outcome line", async () => {
        const run = script({ socket: "/engine.sock" });

        await compose.composePullIfMissing(runtimes.podman, "direct", () => undefined);

        expect(run.logs).toEqual(["  Pulling container images (this may take a moment)…", "  Container images are ready."]);
    });

    test("writes a failure line when the pull fails", async () => {
        const run = script({ socket: "/engine.sock", pulls: { [DEFAULT_IMAGE]: { outcome: { kind: "failed", message: "denied" } } } });

        await compose.composePullIfMissing(runtimes.podman, "direct", () => undefined);

        expect(run.logs).toEqual(["  Pulling container images (this may take a moment)…", "  The pull of the container images failed."]);
    });
});
