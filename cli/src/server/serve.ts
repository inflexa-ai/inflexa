import { closeSync, copyFileSync, openSync, statSync, truncateSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { Subprocess } from "bun";
import type { Hono } from "hono";
import { err, ok, Result } from "neverthrow";

import pkg from "../../package.json";
import { API_VERSION, type ServerDiscovery, type ServerState } from "../api/server.ts";
import { readServerDiscovery, serverBaseUrl } from "../client/api.ts";
import { DEFAULT_ENSURE_SERVER_OPTS, describeServerError, lookupServer, waitForServer } from "../client/server.ts";
import { describeCause } from "../lib/cause.ts";
import { fail, selfInvocation } from "../lib/cli.ts";
import { env } from "../lib/env.ts";
import { mkdirResult, renameResult, rmResult, writeFileResult, type FsError } from "../lib/fs.ts";
import { isPidAlive } from "../lib/lock.ts";
import { getLogger } from "../lib/log.ts";
import { onShutdown, shutdown } from "../lib/shutdown.ts";
import { watchPendingFlush } from "../modules/libs/store.ts";
import { buildApp } from "./app.ts";
import { createServerBoot, DEFAULT_SERVER_BOOT_OPTS } from "./boot.ts";
import type { ServerEnv } from "./http.ts";
import { createServerLifecycle, DEFAULT_SERVER_LIFECYCLE_OPTS } from "./lifecycle.ts";
import { defaultInputDriftOpts, watchInputDrift } from "./profile_queue.ts";

/** The exit code after Ctrl+C: 128 + SIGINT. */
const SIGINT_EXIT_CODE = 130;

/** The hidden flag of `inflexa serve` that runs the detached child of `inflexa serve --detach`. */
export const SERVE_DETACHED_CHILD_FLAG = "--run-detached";

/**
 * The size at which the server log rotates. One old file (`<log>.1`) stays beside it, thus the two files hold
 * about twice this, plus what the server writes between two checks.
 */
export const SERVER_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** How often a detached server measures its log. */
const SERVER_LOG_CHECK_MS = 60_000;

/**
 * How `inflexa serve` runs. `foreground` is a server in the terminal of the person. `detached` is the child
 * of `inflexa serve --detach`: it runs in a session of its own, and its stdout and stderr are the server log.
 */
export type ServeMode = "foreground" | "detached";

/**
 * `inflexa serve`: the composition root of the local server. It binds `127.0.0.1` on the fixed server port of
 * this build channel, writes the discovery file with a new bearer token, then boots the harness runtime behind
 * the routes. The process runs until `POST /api/v1/server/shutdown`, Ctrl+C, SIGTERM, or SIGHUP. Each of these
 * runs the shutdown hooks: the runtime shutdown and the provenance flush. Then the exit hooks remove the
 * discovery file and release the instance locks.
 *
 * The listener stays open until the exit: no new server can bind the port while this one still holds the
 * runtime lock, and the discovery file exists exactly while its process holds the port.
 */
export async function runServe(mode: ServeMode): Promise<void> {
    const startedAt = new Date();
    const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const boot = createServerBoot(startedAt, { ...DEFAULT_SERVER_BOOT_OPTS, onSettle: printBootOutcome });
    const lifecycle = createServerLifecycle({ ...DEFAULT_SERVER_LIFECYCLE_OPTS, exit: () => shutdown(0) });

    // Bind before the discovery file is written: a second server fails here, and it must not replace the file of
    // the server that holds the port.
    listen(buildApp({ token, boot, lifecycle }), env.serverPort).match(
        () => undefined,
        (e) => fail(describeBindFailure(e.cause)),
    );
    const discovery: ServerDiscovery = {
        pid: process.pid,
        port: env.serverPort,
        token,
        version: pkg.version,
        apiVersion: API_VERSION,
        startedAt: startedAt.toISOString(),
        channel: env.isDevelopment ? "development" : "production",
    };
    writeServerDiscovery(env.serverFilePath, discovery).match(
        () => undefined,
        (e) => fail(`Could not write the server discovery file ${env.serverFilePath} (${describeCause(e.cause)}).`),
    );
    // At exit, after the shutdown hooks released the runtime lock: a client that finds no file starts a new
    // server, and that server must find the lock free.
    process.on("exit", () => removeOwnDiscovery(env.serverFilePath));

    // The re-profile after an input change, from each writer in this process: a route, and the
    // `manage_inputs` tool inside a turn.
    const stopInputDrift = watchInputDrift(defaultInputDriftOpts(() => boot.runtime()));
    onShutdown(() => {
        stopInputDrift();
        return Promise.resolve();
    });
    // The 10-second flush gate of the pending store adds runs here, not in a client: an agent add can
    // wait while no TUI runs.
    const stopPendingFlush = watchPendingFlush();
    onShutdown(() => {
        stopPendingFlush();
        return Promise.resolve();
    });
    if (mode === "detached") {
        const stopLogBound = boundServerLog(env.serverLogPath);
        onShutdown(() => {
            stopLogBound();
            return Promise.resolve();
        });
    }

    // src/index.ts leaves SIGINT to each command. For the server, Ctrl+C is the stop. A second Ctrl+C
    // while the shutdown hooks drain exits at once.
    let interrupted = false;
    process.on("SIGINT", () => {
        if (interrupted) process.exit(SIGINT_EXIT_CODE);
        interrupted = true;
        void shutdown(SIGINT_EXIT_CODE);
    });

    const url = serverBaseUrl(env.serverPort);
    console.log(
        mode === "foreground"
            ? `\n  Inflexa server at ${url}. Ctrl+C stops it.\n  Booting the harness runtime…`
            : `Inflexa server ${pkg.version} at ${url}, pid ${process.pid}, started ${startedAt.toISOString()}. \`inflexa server stop\` stops it.`,
    );
    await boot.start();
}

/**
 * `inflexa serve --detach`: start the server as a detached child, wait until it answers, and exit. The child
 * runs in a new session, thus the close of the terminal does not stop it, and its stdout and stderr go to the
 * server log. When a server already answers, this starts none.
 */
export async function runServeDetached(): Promise<void> {
    const opts = DEFAULT_ENSURE_SERVER_OPTS;
    const found = (await lookupServer(opts)).match(
        (lookup) => lookup,
        (e) => fail(describeServerError(e)),
    );
    if (found.kind === "answering") {
        console.log(`An Inflexa server already runs: pid ${found.discovery.pid}, port ${found.discovery.port}.`);
        return;
    }

    // No server writes the log now, thus the rotation before the start loses no line.
    rotateServerLog(env.serverLogPath, SERVER_LOG_ROTATE_BYTES).match(
        () => undefined,
        (e) => console.error(`Could not rotate the server log ${env.serverLogPath} (${describeCause(e.cause)}). The start continues.`),
    );
    const child = spawnDetachedServer(env.serverLogPath).match(
        (c) => c,
        (e) => fail(`Could not start the Inflexa server (${describeCause(e.cause)}). See its log: ${env.serverLogPath}`),
    );
    let exitCode: number | null = null;
    void child.exited.then((code) => {
        exitCode = code;
    });

    const answered = await waitForServer(opts, () => (exitCode === null ? null : `the server exited with code ${exitCode} during its start`));
    answered.match(
        (server) => console.log(`Inflexa server started: pid ${server.discovery.pid}, port ${server.discovery.port}.\n  Log: ${env.serverLogPath}`),
        (e) => fail(describeServerError(e)),
    );
}

/** Bind `app` on `127.0.0.1:port`. Port 0 binds a free port that the OS picks; the server gives it as `port`. */
export function listen(app: Hono<ServerEnv>, port: number): Result<ReturnType<typeof Bun.serve>, { type: "bind_failed"; cause: unknown }> {
    try {
        return ok(Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch }));
    } catch (cause) {
        return err({ type: "bind_failed", cause });
    }
}

/**
 * Write `discovery` to `path` with mode 0600, through a temporary file and a rename. A reader thus never sees a
 * part of the file, and the rename also replaces a file that a killed server left with a wider mode.
 */
export function writeServerDiscovery(path: string, discovery: ServerDiscovery): Result<void, FsError> {
    const temporary = `${path}.${process.pid}.tmp`;
    return mkdirResult(dirname(path), "make the server discovery folder")
        .andThen(() => rmResult(temporary, "remove an old temporary discovery file"))
        .andThen(() => writeFileResult(temporary, `${JSON.stringify(discovery, null, 2)}\n`, "write the server discovery file", { mode: 0o600 }))
        .andThen(() => renameResult(temporary, path, "publish the server discovery file"));
}

/** Remove the discovery file at `path` when it names this process. A sync exit hook has nothing to report a failure to. */
function removeOwnDiscovery(path: string): void {
    if (readServerDiscovery(path).unwrapOr(null)?.pid !== process.pid) return;
    rmResult(path, "remove the server discovery file").match(
        () => undefined,
        () => undefined,
    );
}

/** The message of a failed bind: the server of the discovery file when it holds the port, else a different process. */
function describeBindFailure(cause: unknown): string {
    const port = env.serverPort;
    const holder = readServerDiscovery().unwrapOr(null);
    if (holder !== null && holder.port === port && holder.pid !== process.pid && isPidAlive(holder.pid)) {
        return `An Inflexa server already runs on 127.0.0.1:${port} (pid ${holder.pid}). \`inflexa server status\` shows it, and \`inflexa server stop\` stops it.`;
    }
    return (
        `Could not bind 127.0.0.1:${port} (${describeCause(cause)}). The Inflexa server of this build channel always uses this port, ` +
        `thus a different process can hold it. Stop that process, then start the server again.`
    );
}

/**
 * Rotate the server log when it holds `maxBytes` or more: copy it to `<path>.1`, which replaces the old copy,
 * then truncate it. `true` when it rotated.
 *
 * Copy and truncate, not a rename: the detached server writes through the descriptor that it got at its start,
 * and a rename would move that descriptor to the old file. The descriptor is in append mode, thus a write
 * after the truncation goes to the new end of the file. A line that the server writes between the copy and the
 * truncation is lost.
 */
export function rotateServerLog(path: string, maxBytes: number): Result<boolean, FsError> {
    try {
        if (statSync(path).size < maxBytes) return ok(false);
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
        return ok(true);
    } catch (cause) {
        // `statSync` throws a Node errno error. No log file yet is no rotation.
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok(false);
        return err({ type: "io_failed", op: "rotate the server log", cause });
    }
}

/** Measure the log of a detached server each minute, and rotate it at the bound. Gives the stop of the timer. */
function boundServerLog(path: string): () => void {
    const timer = setInterval(() => {
        rotateServerLog(path, SERVER_LOG_ROTATE_BYTES).match(
            () => undefined,
            (e) => getLogger("server").warn({ err: e.cause, path }, "could not rotate the server log"),
        );
    }, SERVER_LOG_CHECK_MS);
    // The listener keeps the process alive. The timer must not keep it alive after a stop.
    timer.unref();
    return () => clearInterval(timer);
}

/**
 * Spawn the detached child of `inflexa serve --detach`, with its stdout and stderr appended to `logPath`. Its
 * working folder is the home folder, so that a long-lived server holds no folder of the person open.
 */
function spawnDetachedServer(logPath: string): Result<Subprocess, FsError> {
    return mkdirResult(dirname(logPath), "make the server log folder").andThen((): Result<Subprocess, FsError> => {
        let fd: number | undefined;
        try {
            fd = openSync(logPath, "a", 0o600);
            writeSync(fd, `\n--- inflexa serve ${pkg.version}, started ${new Date().toISOString()} ---\n`);
            const child = Bun.spawn({
                cmd: selfInvocation(["serve", SERVE_DETACHED_CHILD_FLAG]),
                cwd: homedir(),
                detached: true,
                stdin: "ignore",
                stdout: fd,
                stderr: fd,
            });
            child.unref();
            return ok(child);
        } catch (cause) {
            return err({ type: "io_failed", op: "start the detached server", cause });
        } finally {
            // The child holds its own copy of the descriptor.
            if (fd !== undefined) closeSync(fd);
        }
    });
}

function printBootOutcome(state: ServerState): void {
    switch (state.phase) {
        case "ready":
            console.log(`  The harness runtime is ready (${state.connection.provider} · ${state.connection.mode} · ${state.connection.model}).`);
            return;
        case "failed":
            console.error(`  The harness runtime failed to boot: ${state.bootError.message}`);
            for (const line of state.bootError.detailLines) console.error(`    ${line}`);
            return;
        case "starting":
            return;
        default: {
            const exhaustive: never = state;
            throw new Error(`unhandled server state: ${JSON.stringify(exhaustive)}`);
        }
    }
}
