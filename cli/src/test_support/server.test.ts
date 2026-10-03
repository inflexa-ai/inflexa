import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";

import { readServerDiscovery } from "../client/api.ts";
import { fetchServerState } from "../client/server.ts";
import { env } from "../lib/env.ts";
import { startTestServer, type TestServer } from "./server.ts";

const started: TestServer[] = [];
afterEach(async () => {
    for (const server of started.splice(0)) await server.stop();
});

function start(): TestServer {
    const server = startTestServer();
    started.push(server);
    return server;
}

describe("startTestServer", () => {
    test("two helpers never share a port or a discovery file, and neither is the dev default", () => {
        const a = start();
        const b = start();
        expect(a.port).not.toBe(b.port);
        expect(a.discoveryPath).not.toBe(b.discoveryPath);
        for (const server of [a, b]) {
            expect(server.port).not.toBe(8436);
            expect(server.discoveryPath).not.toBe(env.serverFilePath);
            expect(statSync(server.discoveryPath).mode & 0o777).toBe(0o600);
            expect(readServerDiscovery(server.discoveryPath)._unsafeUnwrap()).toMatchObject({ pid: process.pid, port: server.port, token: server.token });
            expect(server.childEnv).toEqual({ INFLEXA_SERVER_FILE: server.discoveryPath });
        }
    });

    test("an in-process client reaches it, and the idle boot stays `starting`", async () => {
        const server = start();
        const state = await fetchServerState(server.clientOpts);
        expect(state._unsafeUnwrap().phase).toBe("starting");
    });

    test("stop closes the port and removes the discovery file", async () => {
        const server = startTestServer();
        await server.stop();
        expect(existsSync(server.discoveryPath)).toBe(false);
        expect((await fetchServerState(server.clientOpts))._unsafeUnwrapErr()).toMatchObject({ type: "unreachable", reason: "connection_failed" });
    });
});
