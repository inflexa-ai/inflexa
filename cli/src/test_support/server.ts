import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { ok } from "neverthrow";

import { API_VERSION, type ServerDiscovery, type ServerState } from "../api/server.ts";
import type { ClientOpts } from "../client/api.ts";
import { env } from "../lib/env.ts";
import { buildApp } from "../server/app.ts";
import type { ServerBoot } from "../server/boot.ts";
import type { ServerLifecycle } from "../server/lifecycle.ts";
import { listen, writeServerDiscovery } from "../server/serve.ts";
import { assertTestSandbox } from "./sandbox.ts";

/** A local server for a test, in this process, on a free port, with its own discovery file. */
export type TestServer = {
    /** `http://127.0.0.1:<port>`. */
    readonly baseUrl: string;
    /** The port that the OS picked. */
    readonly port: number;
    readonly token: string;
    /** The discovery file, in a folder of its own inside the test sandbox. Its pid is the pid of this process. */
    readonly discoveryPath: string;
    /** The env that a spawned `inflexa` child needs to find this server. Pass it to `runCliAsync`. */
    readonly childEnv: Record<string, string>;
    /** The client options of a fetcher that runs in this process. */
    readonly clientOpts: ClientOpts;
    /** Stop the listener and remove the folder of the discovery file. */
    stop(): Promise<void>;
};

/**
 * A boot that never starts: the phase stays `starting`, thus a route behind `requireRuntime` gives 503
 * `unavailable`, and each SQLite route works.
 */
export function idleBoot(): ServerBoot {
    const state: ServerState = { version: "0.0.0-test", apiVersion: API_VERSION, startedAt: new Date().toISOString(), phase: "starting" };
    return { state: () => state, runtime: () => null, start: async () => undefined };
}

/**
 * A lifecycle that never stops the process: the test process must outlive each request. It accepts a stop
 * request and records nothing. A test of the stop builds its own lifecycle (server/lifecycle.test.ts).
 */
export function idleLifecycle(): ServerLifecycle {
    return { requestShutdown: (mode) => ({ mode, activeTurns: 0 }), stopping: () => null };
}

/**
 * Start the HTTP app of the server in this process, for an e2e test of an `instance` command. It binds port
 * 0, so the OS picks a free port, and it writes a new discovery file to a new folder inside the test sandbox.
 * Thus two helpers, in one test process or in two, never share a port or a discovery file. It never touches
 * the dev port 8436 or the dev discovery file. A child that runs with `childEnv` connects to it, and never
 * starts a server of its own (`env.serverAutoStart`).
 *
 * The routes read and write the sandboxed SQLite database of this process. Seed and assert through `db/` in
 * the test as before, and do not close the database before the child runs: the child does not open it.
 *
 * Run the child with `runCliAsync` (test_support/cli.ts), never with `runCli`: the sync spawn blocks the
 * event loop that must answer the child. `boot` replaces the idle boot, for a test of a route that needs
 * the runtime.
 */
export function startTestServer(opts: { boot?: ServerBoot } = {}): TestServer {
    const dataDir = dirname(env.dbPath);
    assertTestSandbox(dataDir);
    mkdirSync(dataDir, { recursive: true });
    const discoveryDir = mkdtempSync(join(dataDir, "test-server-"));
    const discoveryPath = join(discoveryDir, "server.json");
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const boot = opts.boot ?? idleBoot();

    // Test support fails loudly: a test with no server has nothing to run against.
    const server = listen(buildApp({ token, boot, lifecycle: idleLifecycle() }), 0).match(
        (s) => s,
        (e) => {
            throw new Error(`startTestServer: could not bind a free port: ${String(e.cause)}`);
        },
    );
    // A TCP listener always has a port; `undefined` is the unix-socket form, which `listen` never makes.
    const port = server.port!;
    const state = boot.state();
    const discovery: ServerDiscovery = {
        pid: process.pid,
        port,
        token,
        version: state.version,
        apiVersion: state.apiVersion,
        startedAt: state.startedAt,
        channel: "development",
    };
    writeServerDiscovery(discoveryPath, discovery).match(
        () => undefined,
        (e) => {
            void server.stop(true);
            throw new Error(`startTestServer: could not write the discovery file ${discoveryPath}: ${String(e.cause)}`);
        },
    );

    const baseUrl = `http://127.0.0.1:${port}`;
    return {
        baseUrl,
        port,
        token,
        discoveryPath,
        childEnv: { INFLEXA_SERVER_FILE: discoveryPath },
        clientOpts: { discover: () => ok({ baseUrl, token }), fetch: (url, init) => fetch(url, init) },
        stop: async () => {
            await server.stop(true);
            rmSync(discoveryDir, { recursive: true, force: true });
        },
    };
}
