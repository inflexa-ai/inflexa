import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import pkg from "../../../package.json";
import { API_VERSION, type ServerActivity, type ServerDiscovery, type ServerState, type ShutdownMode } from "../../api/server.ts";
import { bootServerAfterUp, serverLogs, serverStatus, serverStop, stopServerAfterUpgrade, type ServerCommandOpts, type ServerStatusView } from "./server.ts";

const DISCOVERY: ServerDiscovery = {
    pid: 7001,
    port: 48001,
    token: "t".repeat(64),
    version: pkg.version,
    apiVersion: API_VERSION,
    startedAt: "2026-10-03T08:00:00.000Z",
    channel: "development",
};

const READY: ServerState = {
    version: pkg.version,
    apiVersion: API_VERSION,
    startedAt: DISCOVERY.startedAt,
    phase: "ready",
    connection: { provider: "anthropic", mode: "cliproxy", model: "claude-test" },
};

const IDLE: ServerActivity = { stopping: null, turns: 0, profileDrives: 0, durable: { state: "counted", runs: 0, profiles: 0 } };
const BUSY: ServerActivity = { stopping: null, turns: 2, profileDrives: 0, durable: { state: "counted", runs: 1, profiles: 0 } };

/** A failure of a command: the fake `fail` throws it, as the real one ends the process. */
class CommandFailed extends Error {}

/**
 * A server in memory. `exitAfterPolls` is how many liveness reads the process survives after a stop request;
 * `null` keeps it alive for ever. `shutdownReply` replaces the 202 of the stop request.
 */
function machine(): {
    opts: ServerCommandOpts;
    out: () => string;
    world: {
        file: ServerDiscovery | null;
        answering: boolean;
        live: boolean;
        activity: ServerActivity | null;
        stops: ShutdownMode[];
        exitAfterPolls: number | null;
        shutdownReply: "accepted" | "connection_lost";
        removed: number[];
        tty: boolean;
        answer: boolean;
        questions: string[];
        state: ServerState;
        boots: number;
    };
} {
    const world = {
        file: null as ServerDiscovery | null,
        answering: false,
        live: false,
        activity: IDLE as ServerActivity | null,
        stops: [] as ShutdownMode[],
        exitAfterPolls: 2 as number | null,
        shutdownReply: "accepted" as "accepted" | "connection_lost",
        removed: [] as number[],
        tty: false,
        answer: false,
        questions: [] as string[],
        state: READY,
        boots: 0,
    };
    let output = "";
    let polls = 0;
    let clock = 0;
    const opts: ServerCommandOpts = {
        discoveryPath: "/test/server.dev.json",
        readDiscovery: () => ok(world.file),
        isPidAlive: () => {
            if (world.stops.length > 0 && world.exitAfterPolls !== null && polls++ >= world.exitAfterPolls) world.live = false;
            return world.live;
        },
        fetch: async (url, init) => {
            if (!world.answering) throw new Error("ECONNREFUSED");
            const path = new URL(url).pathname;
            if (path === "/api/v1/server") return Response.json(world.state);
            if (path === "/api/v1/server/boot") {
                world.boots += 1;
                world.state = { ...world.state, phase: "starting" } as ServerState;
                return Response.json(world.state, { status: 202 });
            }
            if (path === "/api/v1/server/activity") {
                return world.activity === null ? Response.json({ error: "internal_error", message: "boom" }, { status: 500 }) : Response.json(world.activity);
            }
            if (path === "/api/v1/server/shutdown") {
                // The route reads the JSON body that `request` serializes.
                const mode = (JSON.parse(String(init.body)) as { mode: ShutdownMode }).mode;
                world.stops.push(mode);
                if (world.shutdownReply === "connection_lost") throw new Error("socket closed");
                return Response.json({ mode, activeTurns: world.activity?.turns ?? 0 }, { status: 202 });
            }
            return Response.json({ error: "not_found", message: path }, { status: 404 });
        },
        probeTimeoutMs: 2_000,
        logPath: "/test/logs/server.dev.log",
        removeStale: (_path, pid) => world.removed.push(pid),
        sleep: (ms) => {
            clock += ms;
            return Promise.resolve();
        },
        now: () => clock,
        exitPollMs: 250,
        stopWaitMs: { now: 60_000, drain: 120_000 },
        followPollMs: 500,
        followSignal: new AbortController().signal,
        write: (text) => {
            output += text;
        },
        fail: (message) => {
            throw new CommandFailed(message);
        },
        interactive: () => world.tty,
        confirm: (question) => {
            world.questions.push(question);
            return Promise.resolve(world.answer);
        },
    };
    return { opts, out: () => output, world };
}

function running(world: ReturnType<typeof machine>["world"]): void {
    world.file = DISCOVERY;
    world.answering = true;
    world.live = true;
}

describe("inflexa server status", () => {
    test("with no server, it says `not running` and names the log", async () => {
        const { opts, out } = machine();
        await serverStatus({ json: false }, opts);
        expect(out()).toContain("Inflexa server: not running");
        expect(out()).toContain(opts.logPath);
    });

    test("a stale file reads as not running, names its pid, and stays on disk", async () => {
        const { opts, out, world } = machine();
        world.file = DISCOVERY;
        await serverStatus({ json: false }, opts);
        expect(out()).toContain(`not running (pid ${DISCOVERY.pid}`);
        expect(world.removed).toEqual([]);
    });

    test("a running server shows its pid, port, phase, both versions, start, work, and log", async () => {
        const { opts, out, world } = machine();
        running(world);
        world.activity = BUSY;
        await serverStatus({ json: false }, opts);
        const text = out();
        expect(text).toContain("Inflexa server: running");
        for (const part of [
            String(DISCOVERY.pid),
            String(DISCOVERY.port),
            "ready (anthropic · cliproxy · claude-test)",
            `server    inflexa ${pkg.version}, API ${API_VERSION}`,
            `client    inflexa ${pkg.version}, API ${API_VERSION}`,
            new Date(DISCOVERY.startedAt).toLocaleString(),
            "2 chat turns, 1 run",
            opts.logPath,
        ]) {
            expect(text).toContain(part);
        }
    });

    test("--json gives the machine-readable view, with the activity", async () => {
        const { opts, out, world } = machine();
        running(world);
        await serverStatus({ json: true }, opts);
        // The command writes `JSON.stringify` of a `ServerStatusView`.
        const view = JSON.parse(out()) as ServerStatusView;
        expect(view).toMatchObject({
            state: "running",
            pid: DISCOVERY.pid,
            port: DISCOVERY.port,
            phase: "ready",
            server: { version: pkg.version, apiVersion: API_VERSION },
            client: { version: pkg.version, apiVersion: API_VERSION },
            activity: IDLE,
            log: opts.logPath,
        });
    });

    test("an activity read that fails shows the work as unknown, and a silent server as not answering", async () => {
        const failed = machine();
        running(failed.world);
        failed.world.activity = null;
        await serverStatus({ json: false }, failed.opts);
        expect(failed.out()).toContain("unknown (the activity read failed)");

        const silent = machine();
        silent.world.file = DISCOVERY;
        silent.world.live = true;
        await serverStatus({ json: true }, silent.opts);
        // The command writes `JSON.stringify` of a `ServerStatusView`.
        expect((JSON.parse(silent.out()) as ServerStatusView).state).toBe("not_answering");
    });
});

describe("inflexa server stop", () => {
    test("with no server, it says so, sends nothing, and succeeds", async () => {
        const { opts, out, world } = machine();
        await serverStop({ mode: "now" }, opts);
        expect(out()).toBe("No Inflexa server runs.\n");
        expect(world.stops).toEqual([]);
    });

    test("a stale file is removed", async () => {
        const { opts, out, world } = machine();
        world.file = DISCOVERY;
        await serverStop({ mode: "now" }, opts);
        expect(world.removed).toEqual([DISCOVERY.pid]);
        expect(out()).toContain("No Inflexa server runs.");
    });

    test.each([["now"], ["drain"]] as const)("`%s` sends its mode and waits until the process exits", async (mode) => {
        const { opts, out, world } = machine();
        running(world);
        world.activity = BUSY;
        await serverStop({ mode }, opts);
        expect(world.stops).toEqual([mode]);
        expect(world.live).toBe(false);
        expect(out()).toContain(`Stopped the Inflexa server (pid ${DISCOVERY.pid}).`);
        if (mode === "drain") expect(out()).toContain("waits up to 60 s for 2 running chat turns");
    });

    test("a stop whose 202 is lost with the connection still waits for the exit", async () => {
        const { opts, out, world } = machine();
        running(world);
        world.shutdownReply = "connection_lost";
        await serverStop({ mode: "now" }, opts);
        expect(out()).toContain("Stopped the Inflexa server");
    });

    test("a process that outlives the wait fails the command, with the pid and the log", async () => {
        const { opts, world } = machine();
        running(world);
        world.exitAfterPolls = null;
        await expect(serverStop({ mode: "now" }, opts)).rejects.toThrow(
            `(pid ${DISCOVERY.pid}) still runs 60 s after the stop request. Its log: ${opts.logPath}`,
        );
    });

    test("a silent server fails the command, and names its pid", async () => {
        const { opts, world } = machine();
        world.file = DISCOVERY;
        world.live = true;
        await expect(serverStop({ mode: "now" }, opts)).rejects.toThrow(`End process ${DISCOVERY.pid} to stop it.`);
        expect(world.stops).toEqual([]);
    });
});

describe("inflexa server logs", () => {
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function logFile(text: string | null): string {
        const dir = mkdtempSync(join(tmpdir(), "inflexa-server-log-"));
        dirs.push(dir);
        const path = join(dir, "server.dev.log");
        if (text !== null) writeFileSync(path, text);
        return path;
    }

    test("prints the path and the last lines, also when they span more than one read", async () => {
        const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(30)}`);
        const { opts, out } = machine();
        const path = logFile(`${lines.join("\n")}\n`);
        await serverLogs({ lines: "3", follow: false }, { ...opts, logPath: path });
        expect(out()).toBe(`==> ${path} <==\n${lines.slice(-3).join("\n")}\n`);
    });

    test("a short log prints whole, and no log says so", async () => {
        const short = machine();
        const path = logFile("a\nb");
        await serverLogs({ lines: "50", follow: false }, { ...short.opts, logPath: path });
        expect(short.out()).toBe(`==> ${path} <==\na\nb`);

        const none = machine();
        await serverLogs({ lines: "50", follow: false }, { ...none.opts, logPath: logFile(null) });
        expect(none.out()).toContain("The server log does not exist yet.");
    });

    test("--lines must be a whole number of 1 or more", async () => {
        const { opts } = machine();
        for (const value of ["0", "-3", "ten", "2.5"]) {
            await expect(serverLogs({ lines: value, follow: false }, { ...opts, logPath: logFile("a\n") })).rejects.toThrow("--lines takes a whole number");
        }
    });

    test("--follow prints each appended line, and starts again at the top after a rotation", async () => {
        const { opts, out } = machine();
        const path = logFile("old\n");
        const stop = new AbortController();
        let polls = 0;
        await serverLogs(
            { lines: "1", follow: true },
            {
                ...opts,
                logPath: path,
                followSignal: stop.signal,
                sleep: () => {
                    polls++;
                    if (polls === 1) appendFileSync(path, "new 1\n");
                    if (polls === 2) {
                        truncateSync(path, 0);
                        appendFileSync(path, "after\n");
                    }
                    if (polls === 3) stop.abort();
                    return Promise.resolve();
                },
            },
        );
        expect(out()).toBe(`==> ${path} <==\nold\nnew 1\nafter\n`);
    });
});

describe("the stop of the old server after `inflexa upgrade`", () => {
    test("with no server, it does nothing", async () => {
        const { opts, out, world } = machine();
        await stopServerAfterUpgrade("9.9.9", opts);
        expect(out()).toBe("");
        expect(world.stops).toEqual([]);
    });

    test("an idle server stops with no question", async () => {
        const { opts, out, world } = machine();
        running(world);
        await stopServerAfterUpgrade("9.9.9", opts);
        expect(world.questions).toEqual([]);
        expect(world.stops).toEqual(["drain"]);
        expect(out()).toContain("The next inflexa command starts inflexa 9.9.9.");
    });

    test("with active work and no terminal, the old server keeps running", async () => {
        const { opts, out, world } = machine();
        running(world);
        world.activity = BUSY;
        await stopServerAfterUpgrade("9.9.9", opts);
        expect(world.questions).toEqual([]);
        expect(world.stops).toEqual([]);
        expect(out()).toContain("keeps running until `inflexa server stop`");
    });

    test("with active work, the question names the work; No keeps the server, and Yes stops it", async () => {
        for (const answer of [false, true]) {
            const { opts, out, world } = machine();
            running(world);
            world.activity = BUSY;
            world.tty = true;
            world.answer = answer;
            await stopServerAfterUpgrade("9.9.9", opts);
            expect(world.questions[0]).toContain("2 chat turns, 1 run");
            expect(world.stops).toEqual(answer ? ["drain"] : []);
            expect(out()).toContain(answer ? "Stopped the old Inflexa server." : "keeps running until `inflexa server stop`");
        }
    });
});

describe("the boot after `inflexa up`", () => {
    const FAILED: ServerState = {
        version: pkg.version,
        apiVersion: API_VERSION,
        startedAt: DISCOVERY.startedAt,
        phase: "failed",
        bootError: { reason: "sign_in_required", message: "no provider login", detailLines: [] },
    };

    test("a server whose boot failed boots again, and the command says so", async () => {
        const { opts, out, world } = machine();
        running(world);
        world.state = FAILED;
        await bootServerAfterUp(opts);
        expect(world.boots).toBe(1);
        expect(out()).toContain("boots again");
    });

    test("a ready server, or no server, gets no request and no line", async () => {
        const ready = machine();
        running(ready.world);
        await bootServerAfterUp(ready.opts);
        const none = machine();
        await bootServerAfterUp(none.opts);
        expect([ready.world.boots, none.world.boots]).toEqual([0, 0]);
        expect(ready.out() + none.out()).toBe("");
    });
});
