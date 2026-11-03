import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readConfig, writeConfig } from "../../../lib/config.ts";
import { runtimes } from "../../../lib/container.ts";
import { env } from "../../../lib/env.ts";
import { assertTestSandbox } from "../../../test_support/sandbox.ts";
import { readCredentialVerdict } from "../credential_state.ts";
import { managementKeyPath } from "../proxy_config.ts";

// `readCredentialVerdict` runs `docker exec` and reads the HTTP answer from its stdout. The test points the docker
// binary at a fake that is ready (`info`) and prints a chosen answer for `exec`, so the check of the status line
// runs as it does against a real proxy.

const realBin = runtimes.docker.bin;
let dir = "";

beforeEach(() => {
    assertTestSandbox(env.configPath);
    assertTestSandbox(managementKeyPath());
    dir = mkdtempSync(join(tmpdir(), "credstate-"));
    const bin = join(dir, "docker");
    writeFileSync(
        bin,
        `#!/bin/sh
case "$1" in
  info) exit 0 ;;
  exec) cat '${join(dir, "answer.txt")}'; exit 0 ;;
esac
exit 1
`,
    );
    chmodSync(bin, 0o755);
    runtimes.docker.bin = bin;
    writeConfig({ ...readConfig(), runtime: "docker" })._unsafeUnwrap();
    mkdirSync(dirname(managementKeyPath()), { recursive: true });
    writeFileSync(managementKeyPath(), "management-key\n");
});

afterEach(() => {
    assertTestSandbox(env.configPath);
    assertTestSandbox(managementKeyPath());
    runtimes.docker.bin = realBin;
    rmSync(env.configPath, { force: true });
    rmSync(managementKeyPath(), { force: true });
    rmSync(dir, { recursive: true, force: true });
});

const BODY = '{"files":[]}';

/** The result of a read when the proxy prints `answer`. */
async function readAnswer(answer: string) {
    writeFileSync(join(dir, "answer.txt"), answer);
    return readCredentialVerdict();
}

describe("readCredentialVerdict — the status line of the management API", () => {
    test("HTTP/1.0 and HTTP/1.1 with status 200 are a good answer", async () => {
        for (const version of ["HTTP/1.0", "HTTP/1.1"]) {
            const result = await readAnswer(`${version} 200 OK\r\nContent-Type: application/json\r\n\r\n${BODY}`);
            expect(result._unsafeUnwrap()).toEqual({ kind: "unknown" });
        }
    });

    test("any other version is a bad response that names the status line", async () => {
        for (const version of ["HTTP/1.2", "HTTP/2.0", "HTTP/1.", "HTTP/1.10", "http/1.1", "XHTTP/1.1"]) {
            const status = `${version} 200 OK`;
            const result = await readAnswer(`${status}\r\n\r\n${BODY}`);
            expect(result._unsafeUnwrapErr()).toEqual({ type: "bad_response", detail: status });
        }
    });

    test("any other status is a bad response that names the status line", async () => {
        for (const status of ["HTTP/1.1 201 Created", "HTTP/1.1 2000 OK", "HTTP/1.1 200", "HTTP/1.1  200 OK", "HTTP/1.1 404 Not Found", " HTTP/1.1 200 OK"]) {
            const result = await readAnswer(`${status}\r\n\r\n${BODY}`);
            expect(result._unsafeUnwrapErr()).toEqual({ type: "bad_response", detail: status });
        }
    });

    test("an answer with no blank line after the head is a bad response", async () => {
        const result = await readAnswer("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n");
        expect(result._unsafeUnwrapErr()).toEqual({ type: "bad_response", detail: "HTTP/1.1 200 OK" });
    });

    test("a good status with a body that is not the auth-files list is a bad response", async () => {
        const result = await readAnswer("HTTP/1.1 200 OK\r\n\r\nnot json");
        expect(result._unsafeUnwrapErr()).toEqual({ type: "bad_response", detail: "unexpected auth-files body" });
    });
});
