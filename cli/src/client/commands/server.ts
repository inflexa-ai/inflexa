import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { err, ok, type Result } from "neverthrow";

import pkg from "../../../package.json";
import {
    API_VERSION,
    SHUTDOWN_DRAIN_LIMIT_MS,
    type ServerActivity,
    type ServerBootError,
    type ServerConnection,
    type ServerDiscovery,
    type ServerPhase,
    type ShutdownMode,
} from "../../api/server.ts";
import { describeCause } from "../../lib/cause.ts";
import { confirm, fail } from "../../lib/cli.ts";
import { env } from "../../lib/env.ts";
import { statResult, type FsError } from "../../lib/fs.ts";
import { describeClientError } from "../api.ts";
import {
    DEFAULT_SERVER_LOOKUP_OPTS,
    describeActivity,
    describeServerError,
    fetchServerActivity,
    hasActiveWork,
    lookupServer,
    removeStaleDiscovery,
    requestServerShutdown,
    SERVER_STOP_WAIT_MS,
    type ServerLookup,
    type ServerLookupOpts,
} from "../server.ts";

/** The size of one read of the server log. A read of the tail grows by this much until it holds the lines. */
const LOG_CHUNK_BYTES = 64 * 1024;

/** What the `inflexa server` commands read, print, and wait on. Tests replace each one. */
export type ServerCommandOpts = ServerLookupOpts & {
    readonly logPath: string;
    readonly removeStale: (path: string, pid: number) => void;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
    /** The interval of the liveness read of the pid while a stop waits for the exit. */
    readonly exitPollMs: number;
    readonly stopWaitMs: Record<ShutdownMode, number>;
    readonly followPollMs: number;
    /** Ends `--follow`. Real: a signal that never aborts, because Ctrl+C ends the process. */
    readonly followSignal: AbortSignal;
    readonly write: (text: string) => void;
    readonly fail: (message: string) => never;
    readonly interactive: () => boolean;
    /** A y/N question whose default is No. */
    readonly confirm: (question: string) => Promise<boolean>;
};

/** The production {@link ServerCommandOpts}. */
export const DEFAULT_SERVER_COMMAND_OPTS: ServerCommandOpts = {
    ...DEFAULT_SERVER_LOOKUP_OPTS,
    logPath: env.serverLogPath,
    removeStale: removeStaleDiscovery,
    sleep: (ms) => Promise.sleep(ms),
    now: () => Date.now(),
    exitPollMs: 250,
    stopWaitMs: SERVER_STOP_WAIT_MS,
    followPollMs: 500,
    followSignal: new AbortController().signal,
    write: (text) => void process.stdout.write(text),
    fail: (message) => fail(message),
    interactive: () => process.stdin.isTTY === true,
    confirm,
};

/** A version of inflexa and of its HTTP API. */
export type VersionView = { version: string; apiVersion: number };

/** The `--json` output of `inflexa server status`. */
export type ServerStatusView =
    | { state: "not_running"; client: VersionView; log: string }
    /** The process of the discovery file lives, but its port did not answer within the probe limit. */
    | { state: "not_answering"; pid: number; port: number; startedAt: string; server: VersionView; client: VersionView; log: string }
    | {
          state: "running";
          pid: number;
          port: number;
          startedAt: string;
          server: VersionView;
          client: VersionView;
          phase: ServerPhase;
          connection: ServerConnection | null;
          bootError: ServerBootError | null;
          /** `null` when the activity read failed. */
          activity: ServerActivity | null;
          log: string;
      };

/**
 * `inflexa server status`: if the server runs, its pid, port, versions, phase, start time, and active work. It
 * never starts a server, and it writes nothing: a stale discovery file stays for `server stop` to remove.
 */
export async function serverStatus(flags: { json: boolean }, opts: ServerCommandOpts = DEFAULT_SERVER_COMMAND_OPTS): Promise<void> {
    const lookup = (await lookupServer(opts)).match(
        (found) => found,
        (e) => opts.fail(describeServerError(e)),
    );
    const view = await statusView(lookup, opts);
    opts.write(flags.json ? `${JSON.stringify(view, null, 2)}\n` : renderStatus(view, lookup));
}

async function statusView(lookup: ServerLookup, opts: ServerCommandOpts): Promise<ServerStatusView> {
    const client: VersionView = { version: pkg.version, apiVersion: API_VERSION };
    switch (lookup.kind) {
        case "none":
        case "stale":
            return { state: "not_running", client, log: opts.logPath };
        case "silent": {
            const d = lookup.discovery;
            return { state: "not_answering", pid: d.pid, port: d.port, startedAt: d.startedAt, server: versionOf(d), client, log: opts.logPath };
        }
        case "answering": {
            const { discovery: d, state } = lookup;
            const activity = await fetchServerActivity(d, opts.fetch);
            return {
                state: "running",
                pid: d.pid,
                port: d.port,
                startedAt: state.startedAt,
                server: { version: state.version, apiVersion: state.apiVersion },
                client,
                phase: state.phase,
                connection: state.phase === "ready" ? state.connection : null,
                bootError: state.phase === "failed" ? state.bootError : null,
                activity: activity.unwrapOr(null),
                log: opts.logPath,
            };
        }
        default: {
            const exhaustive: never = lookup;
            throw new Error(`unhandled server lookup: ${JSON.stringify(exhaustive)}`);
        }
    }
}

function versionOf(discovery: ServerDiscovery): VersionView {
    return { version: discovery.version, apiVersion: discovery.apiVersion };
}

function renderStatus(view: ServerStatusView, lookup: ServerLookup): string {
    const rows = (pairs: [string, string][]): string => pairs.map(([label, value]) => `  ${label.padEnd(8)}  ${value}\n`).join("");
    const versions = (v: VersionView): string => `inflexa ${v.version}, API ${v.apiVersion}`;
    switch (view.state) {
        case "not_running": {
            const head =
                lookup.kind === "stale"
                    ? `Inflexa server: not running (pid ${lookup.discovery.pid} of its discovery file ended without a stop)\n`
                    : "Inflexa server: not running\n";
            return head + rows([["log", view.log]]);
        }
        case "not_answering":
            return (
                `Inflexa server: not answering (pid ${view.pid} lives, but port ${view.port} did not answer)\n` +
                rows([
                    ["pid", String(view.pid)],
                    ["port", String(view.port)],
                    ["started", new Date(view.startedAt).toLocaleString()],
                    ["server", versions(view.server)],
                    ["client", versions(view.client)],
                    ["log", view.log],
                ])
            );
        case "running": {
            const phase =
                view.connection !== null
                    ? `ready (${view.connection.provider} · ${view.connection.mode} · ${view.connection.model})`
                    : view.bootError !== null
                      ? `failed: ${view.bootError.message}`
                      : view.phase;
            return (
                "Inflexa server: running\n" +
                rows([
                    ["pid", String(view.pid)],
                    ["port", String(view.port)],
                    ["phase", phase],
                    ["started", new Date(view.startedAt).toLocaleString()],
                    ["server", versions(view.server)],
                    ["client", versions(view.client)],
                    ["work", view.activity === null ? "unknown (the activity read failed)" : describeActivity(view.activity)],
                    ["log", view.log],
                ])
            );
        }
        default: {
            const exhaustive: never = view;
            throw new Error(`unhandled status view: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * `inflexa server stop` (`--drain`): send the stop request, and wait until the process exits. With no server, it
 * says so and succeeds. A run is a durable workflow: it continues at the next start of a server.
 */
export async function serverStop(flags: { mode: ShutdownMode }, opts: ServerCommandOpts = DEFAULT_SERVER_COMMAND_OPTS): Promise<void> {
    const lookup = (await lookupServer(opts)).match(
        (found) => found,
        (e) => opts.fail(describeServerError(e)),
    );
    switch (lookup.kind) {
        case "none":
            opts.write("No Inflexa server runs.\n");
            return;
        case "stale":
            opts.removeStale(opts.discoveryPath, lookup.discovery.pid);
            opts.write(`No Inflexa server runs. Removed the discovery file of pid ${lookup.discovery.pid}, which ended without a stop.\n`);
            return;
        case "silent":
            return opts.fail(
                `The Inflexa server (pid ${lookup.discovery.pid}) does not answer at port ${lookup.discovery.port}, thus it cannot take the stop request. ` +
                    `End process ${lookup.discovery.pid} to stop it.`,
            );
        case "answering":
            break;
        default: {
            const exhaustive: never = lookup;
            throw new Error(`unhandled server lookup: ${JSON.stringify(exhaustive)}`);
        }
    }
    const stopped = await stopServer(lookup.discovery, flags.mode, opts);
    stopped.match(
        () => opts.write(`Stopped the Inflexa server (pid ${lookup.discovery.pid}).\n`),
        (message) => opts.fail(message),
    );
}

/** Send the stop request to the server of `discovery`, and wait for the exit of its process. */
async function stopServer(discovery: ServerDiscovery, mode: ShutdownMode, opts: ServerCommandOpts): Promise<Result<void, string>> {
    const sent = await requestServerShutdown(discovery, mode, opts.fetch);
    // The exit of a stop can close the connection before the 202 arrives. Thus only an answer with an error ends
    // the stop here, and a broken connection still waits for the exit.
    if (sent.isErr() && sent.error.type !== "unreachable") return err(`The Inflexa server refused the stop: ${describeClientError(sent.error)}`);
    const turns = sent.isOk() ? sent.value.activeTurns : 0;
    const waitTurns =
        sent.isOk() && sent.value.mode === "drain" && turns > 0
            ? ` It waits up to ${SHUTDOWN_DRAIN_LIMIT_MS / 1000} s for ${turns} running chat turn${turns === 1 ? "" : "s"}.`
            : "";
    opts.write(`Stopping the Inflexa server (pid ${discovery.pid}).${waitTurns}\n`);
    const waitMs = opts.stopWaitMs[mode];
    const start = opts.now();
    while (opts.isPidAlive(discovery.pid)) {
        if (opts.now() - start >= waitMs) {
            return err(`The Inflexa server (pid ${discovery.pid}) still runs ${Math.round(waitMs / 1000)} s after the stop request. Its log: ${opts.logPath}`);
        }
        await opts.sleep(opts.exitPollMs);
    }
    return ok(undefined);
}

/**
 * `inflexa server logs`: the path of the server log and its last `lines` lines. With `follow`, it then prints
 * each line that the server appends, also across a rotation, until Ctrl+C.
 */
export async function serverLogs(flags: { lines: string; follow: boolean }, opts: ServerCommandOpts = DEFAULT_SERVER_COMMAND_OPTS): Promise<void> {
    const lines = /^\d+$/.test(flags.lines) ? Number(flags.lines) : 0;
    if (lines < 1) return opts.fail(`--lines takes a whole number of 1 or more, not "${flags.lines}".`);
    opts.write(`==> ${opts.logPath} <==\n`);
    const tail = readLogTail(opts.logPath, lines).match(
        (found) => found,
        (e) => opts.fail(`Could not read the server log ${opts.logPath} (${describeCause(e.cause)}).`),
    );
    if (tail === null) opts.write("The server log does not exist yet. A server that runs in the background writes it.\n");
    else opts.write(tail.text);
    if (!flags.follow) return;

    // One decoder for the whole follow: a character of more than one byte can span two reads.
    const decoder = new TextDecoder();
    let offset = tail?.end ?? 0;
    while (!opts.followSignal.aborted) {
        await opts.sleep(opts.followPollMs);
        const size = statResult(opts.logPath, "measure the server log")
            .map((stats) => stats.size)
            .unwrapOr(0);
        // A smaller file is a rotation: the server copied the log to `<log>.1` and truncated it.
        if (size < offset) offset = 0;
        if (size === offset) continue;
        readLogRange(opts.logPath, offset, size, (bytes) => opts.write(decoder.decode(bytes, { stream: true }))).match(
            () => undefined,
            (e) => opts.fail(`Could not read the server log ${opts.logPath} (${describeCause(e.cause)}).`),
        );
        offset = size;
    }
}

/**
 * The last `lines` lines of the file at `path` and its size, or `null` when there is no file. It reads back from
 * the end in chunks until it holds the lines, thus its cost follows `lines`, not the size of the file.
 */
export function readLogTail(path: string, lines: number): Result<{ text: string; end: number } | null, FsError> {
    let fd: number | undefined;
    try {
        fd = openSync(path, "r");
        const end = fstatSync(fd).size;
        const chunks: Buffer[] = [];
        let start = end;
        let newlines = 0;
        // A file that ends with a newline needs one newline more than its count of lines.
        while (start > 0 && newlines <= lines) {
            const from = Math.max(0, start - LOG_CHUNK_BYTES);
            const chunk = Buffer.alloc(start - from);
            readSync(fd, chunk, 0, chunk.length, from);
            chunks.unshift(chunk);
            for (const byte of chunk) if (byte === 0x0a) newlines++;
            start = from;
        }
        const text = Buffer.concat(chunks).toString("utf8");
        const ended = text.endsWith("\n");
        const kept = (ended ? text.slice(0, -1) : text).split("\n").slice(-lines).join("\n");
        return ok({ text: kept === "" ? "" : ended ? `${kept}\n` : kept, end });
    } catch (cause) {
        // `openSync` throws a Node errno error. No file yet is no tail.
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return ok(null);
        return err({ type: "io_failed", op: "read the server log", cause });
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** Give the bytes of `path` from `from` to `to` to `sink`, one chunk at a time. */
function readLogRange(path: string, from: number, to: number, sink: (bytes: Buffer) => void): Result<void, FsError> {
    let fd: number | undefined;
    try {
        fd = openSync(path, "r");
        for (let at = from; at < to;) {
            const chunk = Buffer.alloc(Math.min(LOG_CHUNK_BYTES, to - at));
            const read = readSync(fd, chunk, 0, chunk.length, at);
            // A truncation between the size read and this read leaves fewer bytes. The next poll starts again at 0.
            if (read === 0) break;
            sink(chunk.subarray(0, read));
            at += read;
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op: "read the server log", cause });
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/**
 * After `inflexa upgrade` replaced the binary: stop the server of the old version, so that the next command
 * starts the new one. With no active work, it stops at once. With active work, it asks first, and the default
 * is No. With no terminal, or with the answer No, the old server keeps running until `inflexa server stop`.
 */
export async function stopServerAfterUpgrade(newVersion: string, opts: ServerCommandOpts = DEFAULT_SERVER_COMMAND_OPTS): Promise<void> {
    const keeps = "The old Inflexa server keeps running until `inflexa server stop`.\n";
    const found = await lookupServer(opts);
    if (found.isErr()) {
        opts.write(`Could not read the state of the Inflexa server (${describeServerError(found.error)}). ${keeps}`);
        return;
    }
    const lookup = found.value;
    if (lookup.kind === "none" || lookup.kind === "stale") return;
    if (lookup.kind === "silent") {
        opts.write(`The old Inflexa server (pid ${lookup.discovery.pid}) does not answer. ${keeps}`);
        return;
    }
    const activity = await fetchServerActivity(lookup.discovery, opts.fetch);
    if (activity.isErr() || hasActiveWork(activity.value)) {
        const work = activity.isOk() ? describeActivity(activity.value) : "unknown, because the activity read failed";
        if (!opts.interactive()) {
            opts.write(`The old Inflexa server (pid ${lookup.discovery.pid}) has active work: ${work}. ${keeps}`);
            return;
        }
        const question =
            `The old Inflexa server (pid ${lookup.discovery.pid}) has active work: ${work}. Stop it now? ` +
            "A chat turn ends, and a run continues at the next start.";
        if (!(await opts.confirm(question))) {
            opts.write(keeps);
            return;
        }
    }
    (await stopServer(lookup.discovery, "drain", opts)).match(
        () => opts.write(`Stopped the old Inflexa server. The next inflexa command starts inflexa ${newVersion}.\n`),
        (message) => opts.write(`${message}\n`),
    );
}
