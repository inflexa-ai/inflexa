import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerDiscovery } from "../api/server.ts";
import { buildProgram } from "../cli/index.ts";
import { readServerDiscovery } from "../client/api.ts";
import { rotateServerLog, SERVE_DETACHED_CHILD_FLAG, serverStopLine, writeServerDiscovery } from "./serve.ts";

let dir: string | null = null;
afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
});

function tempDir(): string {
    dir = mkdtempSync(join(tmpdir(), "inflexa-serve-"));
    return dir;
}

const discovery: ServerDiscovery = {
    pid: 4242,
    port: 8436,
    token: "t".repeat(64),
    version: "0.0.0-test",
    apiVersion: 1,
    startedAt: "2026-10-03T00:00:00.000Z",
    channel: "development",
};

describe("the discovery file", () => {
    test.skipIf(process.platform === "win32")("is written with mode 0600 in a folder that it makes, and reads back whole", () => {
        const root = tempDir();
        const path = join(root, "inflexa", "server.dev.json");
        writeServerDiscovery(path, discovery)._unsafeUnwrap();
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readServerDiscovery(path)._unsafeUnwrap()).toEqual(discovery);
        // The write goes through a temporary file and a rename, thus nothing else stays in the folder.
        expect(readdirSync(join(root, "inflexa"))).toEqual(["server.dev.json"]);
    });

    test.skipIf(process.platform === "win32")("replaces a file that a killed server left with a wider mode", () => {
        const path = join(tempDir(), "server.dev.json");
        writeFileSync(path, JSON.stringify({ ...discovery, pid: 1 }), { mode: 0o644 });
        writeServerDiscovery(path, discovery)._unsafeUnwrap();
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readServerDiscovery(path)._unsafeUnwrap()?.pid).toBe(4242);
    });

    test("an absent file, or a file that is not a discovery record, reads as no server", () => {
        const root = tempDir();
        expect(readServerDiscovery(join(root, "absent.json"))._unsafeUnwrap()).toBeNull();
        for (const [name, text] of [
            ["garbage.json", "not json"],
            ["partial.json", JSON.stringify({ pid: 1, port: 8436 })],
            ["bad-port.json", JSON.stringify({ ...discovery, port: 70000 })],
        ] as const) {
            writeFileSync(join(root, name), text);
            expect(readServerDiscovery(join(root, name))._unsafeUnwrap()).toBeNull();
        }
    });

    test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a file that exists but cannot be read is an error, not an absent server", () => {
        const path = join(tempDir(), "server.dev.json");
        writeFileSync(path, JSON.stringify(discovery), { mode: 0o000 });
        expect(readServerDiscovery(path)._unsafeUnwrapErr()).toMatchObject({ type: "io_failed" });
    });
});

describe("the line that the server log gets at the stop", () => {
    const at = new Date("2026-10-03T16:46:36.000Z");

    test("a stop that a client asked for names the pid, the time, and the mode", () => {
        expect(serverStopLine("drain", 4242, at)).toBe(
            "Inflexa server pid 4242 stops at 2026-10-03T16:46:36.000Z: a client asked for a stop that waits for the chat turns.",
        );
        expect(serverStopLine("now", 4242, at)).toBe("Inflexa server pid 4242 stops at 2026-10-03T16:46:36.000Z: a client asked for an immediate stop.");
    });

    test("a stop with no request of a client is a signal: Ctrl+C, SIGTERM, or SIGHUP", () => {
        expect(serverStopLine(null, 4242, at)).toBe("Inflexa server pid 4242 stops at 2026-10-03T16:46:36.000Z: the process got a stop signal.");
    });
});

describe("rotateServerLog", () => {
    test("a log below the bound, or no log, stays as it is", () => {
        const path = join(tempDir(), "server.dev.log");
        expect(rotateServerLog(path, 10)._unsafeUnwrap()).toBe(false);
        writeFileSync(path, "123456789");
        expect(rotateServerLog(path, 10)._unsafeUnwrap()).toBe(false);
        expect(readFileSync(path, "utf8")).toBe("123456789");
        expect(existsSync(`${path}.1`)).toBe(false);
    });

    test("a log at the bound moves to `.1`, which replaces the old copy, and the log starts again empty", () => {
        const path = join(tempDir(), "server.dev.log");
        writeFileSync(`${path}.1`, "older");
        writeFileSync(path, "0123456789");
        expect(rotateServerLog(path, 10)._unsafeUnwrap()).toBe(true);
        expect(readFileSync(`${path}.1`, "utf8")).toBe("0123456789");
        expect(readFileSync(path, "utf8")).toBe("");
    });
});

test("the registry declares the hidden child flag of `serve` with the spelling that the spawn uses", () => {
    const serve = buildProgram().commands.find((command) => command.name() === "serve");
    expect(serve?.options.map((option) => option.long)).toContain(SERVE_DETACHED_CHILD_FLAG);
});
