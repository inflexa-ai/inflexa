import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { formatInfraStateError, generateApiKey, proxyConfig, writeProxyConfig } from "./proxy_config.ts";
import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";

describe("generateApiKey", () => {
    test("returns an sk- prefixed key of 45 alphanumeric characters", () => {
        expect(generateApiKey()).toMatch(/^sk-[A-Za-z0-9]{45}$/);
    });

    test("returns a different key on each call", () => {
        expect(generateApiKey()).not.toBe(generateApiKey());
    });
});

describe("proxyConfig", () => {
    test("embeds the api key, the proxy port, and the container auth dir as YAML", () => {
        const yaml = proxyConfig("sk-test-key");
        expect(yaml).toContain('api-keys:\n  - "sk-test-key"');
        expect(yaml).toContain(`port: ${env.cliproxyPort}`);
        expect(yaml).toContain('auth-dir: "/root/.cli-proxy-api"');
        expect(yaml).toContain('host: ""');
    });
});

describe("formatInfraStateError", () => {
    const path = "/data/inflexa/cliproxy/config.yaml";

    test("a non-empty directory occupant names the path and says it is not empty", () => {
        const msg = formatInfraStateError({ type: "path_occupied", path, expected: "file", occupant: "non_empty_directory" });
        expect(msg).toContain(path);
        expect(msg).toMatch(/not empty/i);
        expect(msg).toMatch(/will not touch it/i);
    });

    test("a symlink occupant names it as a symlink — never with directory-only prose", () => {
        const msg = formatInfraStateError({ type: "path_occupied", path, expected: "file", occupant: "symlink" });
        expect(msg).toContain(path);
        expect(msg).toMatch(/symlink/i);
        expect(msg).toMatch(/will not follow or delete/i);
        // "not empty" only fits a directory; a symlink must never carry it.
        expect(msg).not.toMatch(/not empty/i);
    });

    test("an other (socket/device) occupant is described as not a regular file, not a directory", () => {
        const msg = formatInfraStateError({ type: "path_occupied", path, expected: "file", occupant: "other" });
        expect(msg).toContain(path);
        expect(msg).toMatch(/not a regular file/i);
        expect(msg).not.toMatch(/not empty/i);
    });

    test("io_failed surfaces the underlying cause message and the path", () => {
        const msg = formatInfraStateError({ type: "io_failed", path: "/data/inflexa/cliproxy/config.yaml", cause: new Error("EACCES: permission denied") });
        expect(msg).toContain("/data/inflexa/cliproxy/config.yaml");
        expect(msg).toContain("EACCES");
    });
});

// writeProxyConfig writes REAL files at env.cliproxyConfigPath / env.cliproxyAuthDir. Under the test
// preload those live inside the mkdtemp sandbox; guard first (the data-loss backstop) and reap the
// cliproxy dir between tests so each starts from a clean slate.
describe("writeProxyConfig damaged-state matrix", () => {
    const configPath = env.cliproxyConfigPath;
    const cliproxyDir = dirname(configPath);

    function reset(): void {
        assertTestSandbox(cliproxyDir);
        rmSync(cliproxyDir, { recursive: true, force: true });
    }
    beforeEach(reset);
    afterEach(reset);

    test("missing file is provisioned with a minted key, 0600 file + 0700 dirs", async () => {
        const outcome = (await writeProxyConfig())._unsafeUnwrap();
        expect(outcome.created).toBe(true);
        if (!outcome.created) throw new Error("unreachable — asserted created above");
        expect(outcome.apiKey).toMatch(/^sk-/);
        expect(readFileSync(configPath, "utf8")).toContain(outcome.apiKey);
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(cliproxyDir).mode & 0o777).toBe(0o700);
        expect(statSync(env.cliproxyAuthDir).mode & 0o777).toBe(0o700);
    });

    test("creates the parent config dir and the auth dir when both are absent", async () => {
        (await writeProxyConfig())._unsafeUnwrap();
        expect(statSync(cliproxyDir).isDirectory()).toBe(true);
        expect(statSync(env.cliproxyAuthDir).isDirectory()).toBe(true);
    });

    test("an EMPTY directory manufactured at the config path is healed: rmdir'd, then the file is written", async () => {
        mkdirSync(configPath, { recursive: true });
        expect(statSync(configPath).isDirectory()).toBe(true);

        const outcome = (await writeProxyConfig())._unsafeUnwrap();
        expect(outcome.created).toBe(true);
        expect(statSync(configPath).isFile()).toBe(true);
    });

    test("a NON-EMPTY directory at the config path is preserved untouched with a path_occupied error", async () => {
        mkdirSync(configPath, { recursive: true });
        writeFileSync(join(configPath, "keep.txt"), "precious");

        const error = (await writeProxyConfig())._unsafeUnwrapErr();
        expect(error.type).toBe("path_occupied");
        if (error.type === "path_occupied") expect(error.path).toBe(configPath);
        // Nothing deleted: the directory and its contents survive (rmdir cannot remove a non-empty dir).
        expect(statSync(configPath).isDirectory()).toBe(true);
        expect(readFileSync(join(configPath, "keep.txt"), "utf8")).toBe("precious");
    });

    test("a SYMLINK at the config path is refused untouched, never followed, and classified as a symlink", async () => {
        // Point the link at a real file so "followed" would be observable — following it would read or
        // clobber the target's bytes. writeProxyConfig must lstat, classify it occupied without following,
        // and delete neither the link nor its target.
        mkdirSync(cliproxyDir, { recursive: true });
        const target = join(cliproxyDir, "elsewhere.txt");
        writeFileSync(target, "target-bytes");
        symlinkSync(target, configPath);

        const error = (await writeProxyConfig())._unsafeUnwrapErr();
        expect(error.type).toBe("path_occupied");
        if (error.type === "path_occupied") {
            expect(error.path).toBe(configPath);
            expect(error.occupant).toBe("symlink");
        }
        // Not followed, not deleted: the symlink itself survives and its target's bytes are intact.
        expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, "utf8")).toBe("target-bytes");
        // The rendered message names the path and calls it a symlink, never a non-empty directory.
        const msg = formatInfraStateError(error);
        expect(msg).toContain(configPath);
        expect(msg).toMatch(/symlink/i);
        expect(msg).not.toMatch(/not empty/i);
    });

    test("is idempotent: a second run reports the existing config without rewriting it", async () => {
        const first = (await writeProxyConfig())._unsafeUnwrap();
        if (!first.created) throw new Error("expected a fresh write on the first run");
        const before = readFileSync(configPath, "utf8");

        const second = (await writeProxyConfig())._unsafeUnwrap();
        expect(second.created).toBe(false);
        // The key is NOT regenerated — the exact same bytes remain on disk.
        expect(readFileSync(configPath, "utf8")).toBe(before);
    });
});
