import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { err, ok, type Result } from "neverthrow";

import pkg from "../../package.json";
import { API_VERSION, type ServerDiscovery, type ServerState } from "../api/server.ts";
import { env } from "../lib/env.ts";
import { acquireInstanceLock, instanceLockPath, releaseInstanceLock, SERVER_SPAWN_LOCK_KEY } from "../lib/lock.ts";
import { assertTestSandbox } from "../test_support/sandbox.ts";
import { describeServerError, ensureServer, lookupServer, type EnsureServerOpts } from "./server.ts";

const DISCOVERY: ServerDiscovery = {
    pid: 7001,
    port: 48001,
    token: "t".repeat(64),
    version: pkg.version,
    apiVersion: API_VERSION,
    startedAt: "2026-10-03T00:00:00.000Z",
    channel: "development",
};

const STARTING: ServerState = { version: pkg.version, apiVersion: API_VERSION, startedAt: DISCOVERY.startedAt, phase: "starting" };

/**
 * A machine in memory: one discovery file, the listeners by port, the live pids, the spawn lock, and a clock
 * that each sleep advances. `startServer` runs `onStart`, which the test sets to make a server appear or fail.
 */
function machine(): {
    opts: EnsureServerOpts;
    world: {
        file: ServerDiscovery | null;
        listening: Map<number, { state: ServerState; status?: number }>;
        live: Set<number>;
        lockHeldBy: number | null;
        starts: number;
        removed: number[];
        notices: string[];
        lockTaken: number;
        lockReleased: number;
        onStart: () => Result<void, string>;
        onSleep: (sleeps: number) => void;
    };
} {
    const world = {
        file: null as ServerDiscovery | null,
        listening: new Map<number, { state: ServerState; status?: number }>(),
        live: new Set<number>(),
        lockHeldBy: null as number | null,
        starts: 0,
        removed: [] as number[],
        notices: [] as string[],
        lockTaken: 0,
        lockReleased: 0,
        onStart: (): Result<void, string> => ok(undefined),
        onSleep: (_sleeps: number): void => undefined,
    };
    let clock = 0;
    let sleeps = 0;
    const opts: EnsureServerOpts = {
        discoveryPath: "/test/server.dev.json",
        readDiscovery: () => ok(world.file),
        isPidAlive: (pid) => world.live.has(pid),
        fetch: (url) => {
            const port = Number(new URL(url).port);
            const listener = world.listening.get(port);
            if (listener === undefined) return Promise.reject(new Error("ECONNREFUSED"));
            const body = listener.status === undefined ? listener.state : { error: "unauthorized", message: "wrong token" };
            return Promise.resolve(Response.json(body, { status: listener.status ?? 200 }));
        },
        probeTimeoutMs: 2_000,
        removeStale: (_path, pid) => {
            world.removed.push(pid);
            if (world.file?.pid === pid) world.file = null;
        },
        sleep: (ms) => {
            clock += ms;
            sleeps += 1;
            world.onSleep(sleeps);
            return Promise.resolve();
        },
        now: () => clock,
        pollMs: 200,
        startWaitMs: 30_000,
        logPath: "/test/logs/server.dev.log",
        autoStart: true,
        acquireSpawnLock: () => {
            world.lockTaken += 1;
            return world.lockHeldBy === null ? { acquired: true } : { acquired: false, holderPid: world.lockHeldBy };
        },
        releaseSpawnLock: () => {
            world.lockReleased += 1;
        },
        startServer: () => {
            world.starts += 1;
            return Promise.resolve(world.onStart());
        },
        notice: (line) => world.notices.push(line),
    };
    return { opts, world };
}

/** A server that runs: its discovery file, its listener, and its live pid. */
function runServer(world: ReturnType<typeof machine>["world"], discovery: ServerDiscovery = DISCOVERY, state: ServerState = STARTING): void {
    world.file = discovery;
    world.listening.set(discovery.port, { state });
    world.live.add(discovery.pid);
}

describe("ensureServer: connect", () => {
    test("a server that answers in any phase is used, and no lock is taken and nothing starts", async () => {
        for (const state of [STARTING, { ...STARTING, phase: "failed", bootError: { reason: "x", message: "y", detailLines: [] } } satisfies ServerState]) {
            const { opts, world } = machine();
            runServer(world, DISCOVERY, state);
            expect((await ensureServer(opts))._unsafeUnwrap()).toEqual({ discovery: DISCOVERY, state });
            expect([world.lockTaken, world.starts]).toEqual([0, 0]);
        }
    });

    test("a listener that answers with an error is refused, and nothing starts", async () => {
        const { opts, world } = machine();
        runServer(world);
        world.listening.set(DISCOVERY.port, { state: STARTING, status: 401 });
        const e = (await ensureServer(opts))._unsafeUnwrapErr();
        expect(e).toMatchObject({ type: "refused" });
        expect(describeServerError(e)).toContain("wrong token");
        expect(world.starts).toBe(0);
    });
});

describe("ensureServer: version skew", () => {
    test("a server of a different apiVersion stops the command with both versions and the stop instruction", async () => {
        const { opts, world } = machine();
        runServer(world, { ...DISCOVERY, apiVersion: API_VERSION + 1 }, { ...STARTING, version: "9.9.9", apiVersion: API_VERSION + 1 });
        const e = (await ensureServer(opts))._unsafeUnwrapErr();
        expect(e.type).toBe("api_mismatch");
        const message = describeServerError(e);
        expect(message).toContain(`inflexa 9.9.9 with API version ${API_VERSION + 1}`);
        expect(message).toContain(`inflexa ${pkg.version} with API version ${API_VERSION}`);
        expect(message).toContain("`inflexa server stop`");
        expect(world.starts).toBe(0);
    });

    test("a server whose package version alone differs is used", async () => {
        const { opts, world } = machine();
        runServer(world, { ...DISCOVERY, version: "0.0.1" }, { ...STARTING, version: "0.0.1" });
        expect((await ensureServer(opts)).isOk()).toBe(true);
    });
});

describe("ensureServer: start", () => {
    test("a stale file is removed, then the client takes the lock, reads again, and starts one server", async () => {
        const { opts, world } = machine();
        world.file = { ...DISCOVERY, pid: 6666 };
        world.onStart = () => {
            runServer(world);
            return ok(undefined);
        };
        expect((await ensureServer(opts))._unsafeUnwrap().discovery).toEqual(DISCOVERY);
        expect(world.removed).toEqual([6666]);
        expect([world.lockTaken, world.starts, world.lockReleased]).toEqual([1, 1, 1]);
        expect(world.notices.join("\n")).toContain(opts.logPath);
    });

    test("a live pid whose port is silent keeps its file, and a start is tried", async () => {
        const { opts, world } = machine();
        world.file = DISCOVERY;
        world.live.add(DISCOVERY.pid);
        world.onStart = () => err("`inflexa serve --detach` exited with code 1");
        expect((await ensureServer(opts))._unsafeUnwrapErr().type).toBe("start_failed");
        expect(world.removed).toEqual([]);
        expect(world.starts).toBe(1);
    });

    test("the read under the lock finds the server that a racing client started, and starts none", async () => {
        const { opts, world } = machine();
        const take = opts.acquireSpawnLock;
        const racing: EnsureServerOpts = {
            ...opts,
            acquireSpawnLock: () => {
                runServer(world);
                return take();
            },
        };
        expect((await ensureServer(racing)).isOk()).toBe(true);
        expect([world.starts, world.lockReleased]).toEqual([0, 1]);
    });

    test("a spawn lock that a different process holds starts nothing, and waits for the server of the holder", async () => {
        const { opts, world } = machine();
        world.lockHeldBy = 4321;
        world.onSleep = (sleeps) => {
            if (sleeps === 3) runServer(world);
        };
        expect((await ensureServer(opts)).isOk()).toBe(true);
        expect([world.starts, world.lockReleased]).toEqual([0, 0]);
    });

    test("a start that fails names the log file, and releases the lock", async () => {
        const { opts, world } = machine();
        world.onStart = () => err("`inflexa serve --detach` exited with code 1");
        const e = (await ensureServer(opts))._unsafeUnwrapErr();
        expect(e).toEqual({ type: "start_failed", detail: "`inflexa serve --detach` exited with code 1", logPath: opts.logPath });
        expect(describeServerError(e)).toContain(`See its log: ${opts.logPath}`);
        expect(world.lockReleased).toBe(1);
    });

    test("a started server that never answers ends at the bound, and the error names the log file", async () => {
        const { opts } = machine();
        const e = (await ensureServer(opts))._unsafeUnwrapErr();
        expect(e).toMatchObject({ type: "start_timeout", logPath: opts.logPath });
        if (e.type === "start_timeout") expect(e.waitedMs).toBeGreaterThanOrEqual(opts.startWaitMs);
        expect(describeServerError(e)).toContain(opts.logPath);
    });

    test("with auto start off, no answer is `not_running`: no lock, no start, and the message names `inflexa serve`", async () => {
        const { opts, world } = machine();
        const e = (await ensureServer({ ...opts, autoStart: false }))._unsafeUnwrapErr();
        expect(e).toEqual({ type: "not_running", path: opts.discoveryPath });
        expect(describeServerError(e)).toContain("`inflexa serve`");
        expect([world.lockTaken, world.starts]).toEqual([0, 0]);
    });
});

describe("lookupServer", () => {
    test("tells a stale file from a silent server, and writes nothing", async () => {
        const { opts, world } = machine();
        world.file = DISCOVERY;
        expect((await lookupServer(opts))._unsafeUnwrap()).toEqual({ kind: "stale", discovery: DISCOVERY });
        world.live.add(DISCOVERY.pid);
        expect((await lookupServer(opts))._unsafeUnwrap()).toEqual({ kind: "silent", discovery: DISCOVERY });
        world.file = null;
        expect((await lookupServer(opts))._unsafeUnwrap()).toEqual({ kind: "none" });
        expect(world.removed).toEqual([]);
    });

    test("a discovery file that cannot be read is an error that names the path", async () => {
        const { opts } = machine();
        const e = (await lookupServer({ ...opts, readDiscovery: () => err({ type: "io_failed", op: "read", cause: new Error("EACCES") }) }))._unsafeUnwrapErr();
        expect(e).toMatchObject({ type: "discovery_unreadable", path: opts.discoveryPath });
    });
});

// The real O_EXCL lock of `lib/lock.ts`, under the key that `ensureServer` takes in production.
describe("the server-spawn lock", () => {
    beforeEach(() => {
        assertTestSandbox(env.locksDir);
    });
    afterEach(() => {
        rmSync(instanceLockPath(SERVER_SPAWN_LOCK_KEY), { force: true });
    });

    test("a client finds the lock of a live client, starts nothing, and connects to the server of that client", async () => {
        mkdirSync(dirname(instanceLockPath(SERVER_SPAWN_LOCK_KEY)), { recursive: true });
        // The parent of this test process lives for the whole test, thus it reads as a live holder.
        writeFileSync(instanceLockPath(SERVER_SPAWN_LOCK_KEY), String(process.ppid));
        const { opts, world } = machine();
        world.onSleep = (sleeps) => {
            if (sleeps === 2) runServer(world);
        };
        const real: EnsureServerOpts = {
            ...opts,
            acquireSpawnLock: () => acquireInstanceLock(SERVER_SPAWN_LOCK_KEY),
            releaseSpawnLock: () => releaseInstanceLock(SERVER_SPAWN_LOCK_KEY),
        };
        expect((await ensureServer(real)).isOk()).toBe(true);
        expect(world.starts).toBe(0);
    });

    test("a free lock is taken for the start, and released after it", async () => {
        const { opts, world } = machine();
        let heldDuringStart = false;
        world.onStart = () => {
            heldDuringStart = readFileSync(instanceLockPath(SERVER_SPAWN_LOCK_KEY), "utf8").trim() === String(process.pid);
            runServer(world);
            return ok(undefined);
        };
        const real: EnsureServerOpts = {
            ...opts,
            acquireSpawnLock: () => acquireInstanceLock(SERVER_SPAWN_LOCK_KEY),
            releaseSpawnLock: () => releaseInstanceLock(SERVER_SPAWN_LOCK_KEY),
        };
        expect((await ensureServer(real)).isOk()).toBe(true);
        expect(heldDuringStart).toBe(true);
        expect(existsSync(instanceLockPath(SERVER_SPAWN_LOCK_KEY))).toBe(false);
    });
});
