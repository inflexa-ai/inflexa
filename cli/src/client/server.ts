import { err, ok, Result, ResultAsync } from "neverthrow";

import pkg from "../../package.json";
import {
    API_VERSION,
    SHUTDOWN_DRAIN_LIMIT_MS,
    type ServerActivity,
    type ServerDiscovery,
    type ServerState,
    type ShutdownAccepted,
    type ShutdownMode,
} from "../api/server.ts";
import { describeCause } from "../lib/cause.ts";
import { fail, selfInvocation } from "../lib/cli.ts";
import { env } from "../lib/env.ts";
import { rmResult, type FsError } from "../lib/fs.ts";
import { acquireInstanceLock, isPidAlive, releaseInstanceLock, SERVER_SPAWN_LOCK_KEY, type LockOutcome } from "../lib/lock.ts";
import { DEFAULT_CLIENT_OPTS, describeClientError, readServerDiscovery, request, serverBaseUrl, type ClientError, type ClientOpts } from "./api.ts";

/** The upper bound of one probe of a server. A local listener answers in milliseconds. */
const PROBE_TIMEOUT_MS = 2_000;

/** The upper bound of a request to a server that answered its probe, for a read that can touch Postgres. */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long a client waits for a server that it started, from the spawn to the first answer. */
export const SERVER_START_WAIT_MS = 30_000;

/**
 * How long `inflexa server stop` waits for the exit of the process. A `drain` stop first waits for the chat
 * turns, thus it adds the drain limit of the server. The rest covers the shutdown of the runtime.
 */
export const SERVER_STOP_WAIT_MS: Record<ShutdownMode, number> = { now: 60_000, drain: SHUTDOWN_DRAIN_LIMIT_MS + 60_000 };

/** `GET /api/v1/server`: the boot phase of the server, its boot error, and its model connection. */
export function fetchServerState(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ServerState, ClientError> {
    return request<ServerState>("GET", "/api/v1/server", {}, opts);
}

/** `POST /api/v1/server/boot`: boot again after a failed boot. The server answers 202 with its state at once. */
export function requestServerBoot(opts: ClientOpts = DEFAULT_CLIENT_OPTS): ResultAsync<ServerState, ClientError> {
    return request<ServerState>("POST", "/api/v1/server/boot", {}, opts);
}

/** What the discovery file of this channel says about a server right now. */
export type ServerLookup =
    /** No usable discovery file. */
    | { readonly kind: "none" }
    /** The file names a process that is gone: a server that a crash or a kill ended. */
    | { readonly kind: "stale"; readonly discovery: ServerDiscovery }
    /** The process of the file lives, but its port did not answer within the probe limit. */
    | { readonly kind: "silent"; readonly discovery: ServerDiscovery }
    | { readonly kind: "answering"; readonly discovery: ServerDiscovery; readonly state: ServerState };

/** A server that answered: its discovery file, and the state that it sent. */
export type ConnectedServer = { readonly discovery: ServerDiscovery; readonly state: ServerState };

/** Why a command has no server that it can use. */
export type ServerError =
    | { readonly type: "discovery_unreadable"; readonly path: string; readonly cause: unknown }
    /** A listener on the port of the file answered the probe with an error, for example a token that does not match. */
    | { readonly type: "refused"; readonly discovery: ServerDiscovery; readonly error: ClientError }
    /** No server answers, and this client does not start one (`INFLEXA_SERVER_FILE` names the server). */
    | { readonly type: "not_running"; readonly path: string }
    /** The server speaks a different version of the HTTP API. */
    | { readonly type: "api_mismatch"; readonly discovery: ServerDiscovery; readonly state: ServerState }
    | { readonly type: "start_failed"; readonly detail: string; readonly logPath: string }
    | { readonly type: "start_timeout"; readonly waitedMs: number; readonly logPath: string };

/** How a client reads the discovery file and probes the server that it names. Tests replace each one. */
export type ServerLookupOpts = {
    readonly discoveryPath: string;
    readonly readDiscovery: (path: string) => Result<ServerDiscovery | null, FsError>;
    readonly isPidAlive: (pid: number) => boolean;
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
    readonly probeTimeoutMs: number;
};

/** The production {@link ServerLookupOpts}: the discovery file of this channel, and a probe of 2 s. */
export const DEFAULT_SERVER_LOOKUP_OPTS: ServerLookupOpts = {
    discoveryPath: env.serverFilePath,
    readDiscovery: readServerDiscovery,
    isPidAlive,
    fetch: (url, init) => fetch(url, init),
    probeTimeoutMs: PROBE_TIMEOUT_MS,
};

/** The client options of the server that `discovery` names, with an upper bound on each request. */
export function serverClient(discovery: ServerDiscovery, fetchFn: ServerLookupOpts["fetch"], timeoutMs: number): ClientOpts {
    const endpoint = { baseUrl: serverBaseUrl(discovery.port), token: discovery.token };
    return {
        discover: () => ok(endpoint),
        fetch: (url, init) => fetchFn(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) }),
    };
}

/**
 * Read the discovery file, and probe the server that it names with `GET /api/v1/server`. A probe that gets no
 * answer reads the pid: a dead pid is a stale file. This writes nothing, thus a read-only command can call it.
 */
export async function lookupServer(opts: ServerLookupOpts = DEFAULT_SERVER_LOOKUP_OPTS): Promise<Result<ServerLookup, ServerError>> {
    const read = opts.readDiscovery(opts.discoveryPath);
    if (read.isErr()) return err({ type: "discovery_unreadable", path: opts.discoveryPath, cause: read.error.cause });
    const discovery = read.value;
    if (discovery === null) return ok({ kind: "none" });
    const probe = await fetchServerState(serverClient(discovery, opts.fetch, opts.probeTimeoutMs));
    if (probe.isOk()) return ok({ kind: "answering", discovery, state: probe.value });
    switch (probe.error.type) {
        case "http":
        case "bad_json":
            return err({ type: "refused", discovery, error: probe.error });
        case "unreachable":
        case "aborted":
            return ok(opts.isPidAlive(discovery.pid) ? { kind: "silent", discovery } : { kind: "stale", discovery });
        default: {
            const exhaustive: never = probe.error;
            throw new Error(`unhandled client error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Remove the discovery file at `path` when it still names `pid`. The file is read again first: a server that
 * started since the lookup wrote a new file, and that file must stay.
 */
export function removeStaleDiscovery(path: string, pid: number): void {
    if (readServerDiscovery(path).unwrapOr(null)?.pid !== pid) return;
    // A stale file that stays does no harm: the next server replaces it with a rename.
    rmResult(path, "remove a stale server discovery file").match(
        () => undefined,
        () => undefined,
    );
}

/** What {@link waitForServer} reads and how long it waits. Tests replace each one. */
export type ServerWaitOpts = ServerLookupOpts & {
    readonly removeStale: (path: string, pid: number) => void;
    readonly sleep: (ms: number) => Promise<void>;
    readonly now: () => number;
    readonly pollMs: number;
    readonly startWaitMs: number;
    /** The log of a background server, which a start error names. */
    readonly logPath: string;
};

/** What {@link ensureServer} reads, locks, and starts. Tests replace each one. */
export type EnsureServerOpts = ServerWaitOpts & {
    /** False when a different owner starts and stops the server, for example a test. */
    readonly autoStart: boolean;
    readonly acquireSpawnLock: () => LockOutcome;
    readonly releaseSpawnLock: () => void;
    /** Run `inflexa serve --detach`, and settle at its exit. The error channel holds why it failed. */
    readonly startServer: () => Promise<Result<void, string>>;
    /** Tells the person why the command waits. */
    readonly notice: (line: string) => void;
};

/** The production {@link EnsureServerOpts}. */
export const DEFAULT_ENSURE_SERVER_OPTS: EnsureServerOpts = {
    ...DEFAULT_SERVER_LOOKUP_OPTS,
    removeStale: removeStaleDiscovery,
    sleep: (ms) => Promise.sleep(ms),
    now: () => Date.now(),
    pollMs: 200,
    startWaitMs: SERVER_START_WAIT_MS,
    logPath: env.serverLogPath,
    autoStart: env.serverAutoStart,
    acquireSpawnLock: () => acquireInstanceLock(SERVER_SPAWN_LOCK_KEY),
    releaseSpawnLock: () => releaseInstanceLock(SERVER_SPAWN_LOCK_KEY),
    startServer: startDetachedServer,
    notice: (line) => console.error(line),
};

/**
 * Connect to the local server, or start one: the check of each `instance` command before its action runs.
 *
 * A server that answers in any phase counts, because the SQLite routes work before the runtime is ready. With
 * no answer, the client removes a stale discovery file, takes the `server-spawn` lock, reads the file again,
 * and runs `inflexa serve --detach`. A client that finds the lock held starts nothing, and waits for the
 * answer of the server that the holder starts. A server with a different `apiVersion` is refused: its routes
 * can send bodies that this client does not know.
 */
export async function ensureServer(opts: EnsureServerOpts = DEFAULT_ENSURE_SERVER_OPTS): Promise<Result<ConnectedServer, ServerError>> {
    const found = await findAnsweringServer(opts);
    if (found.isErr()) return err(found.error);
    if (found.value !== null) return sameApiVersion(found.value);
    if (!opts.autoStart) return err({ type: "not_running", path: opts.discoveryPath });

    const lock = opts.acquireSpawnLock();
    if (!lock.acquired) return (await waitForServer(opts, () => null)).andThen(sameApiVersion);
    try {
        const again = await findAnsweringServer(opts);
        if (again.isErr()) return err(again.error);
        if (again.value !== null) return sameApiVersion(again.value);
        opts.notice(`Starting the Inflexa server in the background. Its log: ${opts.logPath}`);
        const started = await opts.startServer();
        if (started.isErr()) return err({ type: "start_failed", detail: started.error, logPath: opts.logPath });
        return (await waitForServer(opts, () => null)).andThen(sameApiVersion);
    } finally {
        opts.releaseSpawnLock();
    }
}

/**
 * Probe until a server answers, up to the start limit. `gaveUp` ends the wait early with its reason, for
 * example the exit of the process that was to answer.
 */
export async function waitForServer(opts: ServerWaitOpts, gaveUp: () => string | null): Promise<Result<ConnectedServer, ServerError>> {
    const start = opts.now();
    for (;;) {
        const found = await findAnsweringServer(opts);
        if (found.isErr()) return err(found.error);
        if (found.value !== null) return ok(found.value);
        const reason = gaveUp();
        if (reason !== null) return err({ type: "start_failed", detail: reason, logPath: opts.logPath });
        const waitedMs = opts.now() - start;
        if (waitedMs >= opts.startWaitMs) return err({ type: "start_timeout", waitedMs, logPath: opts.logPath });
        await opts.sleep(opts.pollMs);
    }
}

/** The server that answers, or `null`. A stale discovery file is removed on the way. */
async function findAnsweringServer(opts: ServerWaitOpts): Promise<Result<ConnectedServer | null, ServerError>> {
    const found = await lookupServer(opts);
    if (found.isErr()) return err(found.error);
    const lookup = found.value;
    switch (lookup.kind) {
        case "answering":
            return ok({ discovery: lookup.discovery, state: lookup.state });
        case "stale":
            opts.removeStale(opts.discoveryPath, lookup.discovery.pid);
            return ok(null);
        case "none":
        case "silent":
            return ok(null);
        default: {
            const exhaustive: never = lookup;
            throw new Error(`unhandled server lookup: ${JSON.stringify(exhaustive)}`);
        }
    }
}

function sameApiVersion(server: ConnectedServer): Result<ConnectedServer, ServerError> {
    return server.state.apiVersion === API_VERSION ? ok(server) : err({ type: "api_mismatch", discovery: server.discovery, state: server.state });
}

/** How long a client waits for the exit of `inflexa serve --detach`: its own start limit, and a margin for its startup. */
const START_COMMAND_WAIT_MS = SERVER_START_WAIT_MS + 15_000;

/**
 * Run `inflexa serve --detach` with the same executable: the compiled binary, or `bun` and the source entry in a
 * dev checkout. Its stdout would mix into the output of the command, thus only its stderr reaches the person:
 * `inherit` prints it in the terminal of a command, and `pipe` puts it into the error, for a TUI that owns the
 * terminal.
 */
export async function startDetachedServer(stderr: "inherit" | "pipe" = "inherit"): Promise<Result<void, string>> {
    const spawned = Result.fromThrowable(
        () => Bun.spawn({ cmd: selfInvocation(["serve", "--detach"]), stdin: "ignore", stdout: "ignore", stderr }),
        (cause) => describeCause(cause),
    )();
    if (spawned.isErr()) return err(`the spawn of \`inflexa serve --detach\` failed (${spawned.error})`);
    const child = spawned.value;
    const code = await Promise.race([child.exited, Promise.sleep(START_COMMAND_WAIT_MS).then(() => null)]);
    if (code === null) return err(`\`inflexa serve --detach\` did not finish within ${START_COMMAND_WAIT_MS / 1000} s`);
    if (code === 0) return ok(undefined);
    const said =
        child.stderr instanceof ReadableStream ? (await ResultAsync.fromPromise(new Response(child.stderr).text(), () => null)).unwrapOr("").trim() : "";
    return err(`\`inflexa serve --detach\` exited with code ${code}${said === "" ? "" : `: ${said}`}`);
}

/** One message for a person, for each {@link ServerError}. */
export function describeServerError(e: ServerError): string {
    switch (e.type) {
        case "discovery_unreadable":
            return `Could not read the server discovery file ${e.path} (${describeCause(e.cause)}).`;
        case "refused":
            return `The Inflexa server at ${serverBaseUrl(e.discovery.port)} (pid ${e.discovery.pid}) refused the request: ${describeClientError(e.error)}`;
        case "not_running":
            return `No Inflexa server runs: ${e.path} names none. Start the server with \`inflexa serve\`, then try again.`;
        case "api_mismatch":
            return (
                `The Inflexa server (pid ${e.discovery.pid}) is inflexa ${e.state.version} with API version ${e.state.apiVersion}, ` +
                `and this command is inflexa ${pkg.version} with API version ${API_VERSION}. Run \`inflexa server stop\`, then try again.`
            );
        case "start_failed":
            return `Could not start the Inflexa server: ${e.detail}. See its log: ${e.logPath}`;
        case "start_timeout":
            return `The Inflexa server did not answer within ${Math.round(e.waitedMs / 1000)} s of its start. See its log: ${e.logPath}`;
        default: {
            const exhaustive: never = e;
            throw new Error(`unhandled server error: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Connect to the local server, or start one, then give. Otherwise print why and exit. The check of each
 * `instance` command before its action runs (cli/agent_policy.ts).
 */
export async function requireServer(opts: EnsureServerOpts = DEFAULT_ENSURE_SERVER_OPTS): Promise<void> {
    (await ensureServer(opts)).match(
        () => undefined,
        (e) => fail(describeServerError(e)),
    );
}

/** `GET /api/v1/server/activity`: the work that a stop of the server interrupts. */
export function fetchServerActivity(
    discovery: ServerDiscovery,
    fetchFn: ServerLookupOpts["fetch"] = DEFAULT_SERVER_LOOKUP_OPTS.fetch,
): ResultAsync<ServerActivity, ClientError> {
    return request<ServerActivity>("GET", "/api/v1/server/activity", {}, serverClient(discovery, fetchFn, REQUEST_TIMEOUT_MS));
}

/** `POST /api/v1/server/shutdown`: start the stop of the server. The server answers 202 at once. */
export function requestServerShutdown(
    discovery: ServerDiscovery,
    mode: ShutdownMode,
    fetchFn: ServerLookupOpts["fetch"] = DEFAULT_SERVER_LOOKUP_OPTS.fetch,
): ResultAsync<ShutdownAccepted, ClientError> {
    return request<ShutdownAccepted>("POST", "/api/v1/server/shutdown", { body: { mode } }, serverClient(discovery, fetchFn, REQUEST_TIMEOUT_MS));
}

/** True when `activity` holds work that a stop interrupts. A ledger that cannot be read counts as work. */
export function hasActiveWork(activity: ServerActivity): boolean {
    const durable = activity.durable;
    const durableWork = durable.state === "unreadable" || (durable.state === "counted" && durable.runs + durable.profiles > 0);
    return activity.turns > 0 || activity.profileDrives > 0 || durableWork;
}

/** The work of `activity` for a person, for example `1 chat turn, 2 runs`, or `none`. */
export function describeActivity(activity: ServerActivity): string {
    const count = (n: number, one: string, many: string): string | null => (n === 0 ? null : `${n} ${n === 1 ? one : many}`);
    const durable = activity.durable;
    const parts = [
        count(activity.turns, "chat turn", "chat turns"),
        count(activity.profileDrives, "profile drive", "profile drives"),
        durable.state === "counted" ? count(durable.runs, "run", "runs") : null,
        durable.state === "counted" ? count(durable.profiles, "data profile", "data profiles") : null,
        durable.state === "unreadable" ? "runs and data profiles unknown (the ledger read failed)" : null,
    ].filter((part) => part !== null);
    const work = parts.length === 0 ? "none" : parts.join(", ");
    return activity.stopping === null ? work : `${work} (stopping: ${activity.stopping})`;
}

/**
 * Stop `command` with an instruction when a server runs. For a `machine` command that must not run under a
 * live server. With no live discovery file, the port of this channel is probed with no token: a server whose
 * file is gone still holds the Postgres and the runtime.
 */
export async function refuseWhileServerAnswers(command: string, opts: ServerLookupOpts = DEFAULT_SERVER_LOOKUP_OPTS): Promise<void> {
    const found = (await lookupServer(opts)).match(
        (lookup): ServerLookup => lookup,
        (e): ServerLookup => (e.type === "refused" ? { kind: "silent", discovery: e.discovery } : fail(describeServerError(e))),
    );
    if (found.kind === "answering" || found.kind === "silent") {
        fail(
            `An Inflexa server runs (pid ${found.discovery.pid}, port ${found.discovery.port}). Stop it with \`inflexa server stop\`, then run \`${command}\` again.`,
        );
    }
    const baseUrl = serverBaseUrl(env.serverPort);
    const probe = await ResultAsync.fromPromise(opts.fetch(`${baseUrl}/api/v1/server`, { signal: AbortSignal.timeout(opts.probeTimeoutMs) }), () => null);
    if (probe.isOk()) fail(`A server answers at ${baseUrl}, the port of the Inflexa server. Stop it first, then run \`${command}\` again.`);
}
