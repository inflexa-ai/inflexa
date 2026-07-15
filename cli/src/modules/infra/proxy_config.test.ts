import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    test("path_occupied names the offending path and refuses to touch it", () => {
        const msg = formatInfraStateError({ type: "path_occupied", path: "/data/inflexa/cliproxy/config.yaml", expected: "file" });
        expect(msg).toContain("/data/inflexa/cliproxy/config.yaml");
        expect(msg).toMatch(/will not touch it/i);
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
