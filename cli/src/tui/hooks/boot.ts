import { createEffect, createSignal, on } from "solid-js";
import type { CliRenderer } from "@opentui/core";
import { Result, type ResultAsync } from "neverthrow";

import type { AgentEffort, AgentList, AgentName, AgentSelection } from "../../api/machine.ts";
import { API_VERSION, SIGN_IN_REQUIRED, type ServerConnection, type ServerDiscovery, type ServerState } from "../../api/server.ts";
import { describeClientError, readServerDiscovery, type ClientError } from "../../client/api.ts";
import { fetchAgents } from "../../client/machine.ts";
import {
    DEFAULT_ENSURE_SERVER_OPTS,
    describeServerError,
    ensureServer,
    fetchServerState,
    requestServerBoot,
    startDetachedServer,
} from "../../client/server.ts";
import { describeCause } from "../../lib/cause.ts";
import { selfInvocation } from "../../lib/cli.ts";
import { notify } from "./notice.ts";
import { chatStatus } from "./status.ts";

// The boot of the harness runtime as the chat UI sees it. The local server boots the runtime; this store
// mirrors the phase that `GET /api/v1/server` gives, so `app.tsx` can gate submits, paint the status bar,
// and mount the boot animation. Mirrors the `status.ts` / `theme.ts` store shape (a reactive accessor + a
// single indirect mutator). One chat screen runs at a time, so a module singleton is correct.

/**
 * The boot phase surfaced to the chat UI:
 * - `idle` — the launcher did not start {@link watchServerBoot} yet (the first frame);
 * - `booting` — the server is `starting`; the input is gated and the animation renders;
 * - `ready` — the server runtime is ready, carrying the conversation agent's `model` at boot and the shared
 *   `connection` identity (provider slug + mode) the status surface renders;
 * - `failed` — the boot failed, or no server answers, carrying one actionable `message` and the `recovery`
 *   that the chat offers (none when a server answered with a refusal). The store leaves it through
 *   {@link recoverServerBoot}, through {@link checkServer} when a server answers again, or the user quits.
 *
 * The connection rides the `ready` variant — not the swap-tracking {@link agentModels} store — because it
 * is a boot-resolved, immutable fact (a live role-model swap never changes the connection — all roles
 * share one connection, so a swap changes only a model), so it is seeded ONCE at the ready edge, exactly
 * matching this variant's set-once-and-never-mutate lifecycle.
 */
export type BootState =
    | { phase: "idle" }
    | { phase: "booting" }
    | { phase: "ready"; model: string; connection: Pick<ServerConnection, "provider" | "mode"> }
    | { phase: "failed"; message: string; recovery?: BootRecovery };

/**
 * What the chat offers for a failed boot: `sign_in` runs `inflexa up` in the terminal, `boot_again` asks the
 * server for a new boot, and `start_server` starts a server when none answers.
 */
export type BootRecovery = "sign_in" | "boot_again" | "start_server";

const [state, setState] = createSignal<BootState>({ phase: "idle" });

// The start time of the server whose boot the store settled as `ready`. A probe that gets a different one
// found a new server, which booted apart from this store. Plain infrastructure: nothing reacts to it.
let readyServerStartedAt: string | null = null;

/** Read the current boot phase — call inside a tracking scope for reactivity. */
export const bootState = state;

/** How {@link watchServerBoot} reads the server, and how long it waits between two reads. Tests replace each one. */
export type BootWatchOpts = {
    readonly readState: () => ResultAsync<ServerState, ClientError>;
    readonly sleep: (ms: number) => Promise<void>;
    readonly pollMs: number;
};

/** The production {@link BootWatchOpts}: `GET /api/v1/server` each 500 ms. */
export const DEFAULT_BOOT_WATCH_OPTS: BootWatchOpts = {
    readState: () => fetchServerState(),
    sleep: (ms) => Promise.sleep(ms),
    pollMs: 500,
};

/**
 * Read the server state until its phase is `ready` or `failed`, and publish it to the boot store. A read
 * that fails (no server answers) settles the store as `failed` with the instruction of the client error.
 *
 * Idempotent while in flight or settled-ready: a call whose current phase is already `booting` or `ready`
 * is a no-op, so the launcher may fire it once post-render (fire-and-forget) without guarding against a
 * double-open.
 */
export async function watchServerBoot(opts: BootWatchOpts = DEFAULT_BOOT_WATCH_OPTS): Promise<void> {
    const phase = state().phase;
    // Synchronous up to the `setState` in `followBoot` (no `await` before it), so a second call within
    // the same JS turn already observes `booting` — the guard needs no extra in-flight flag.
    if (phase === "booting" || phase === "ready") return;
    await followBoot(opts);
}

/** Publish `booting`, then read the server state until its phase is `ready` or `failed`, and publish it. */
async function followBoot(opts: BootWatchOpts): Promise<void> {
    setState({ phase: "booting" });
    for (;;) {
        const read = await opts.readState();
        const settled = read.match(
            (server): BootState | null => {
                switch (server.phase) {
                    case "starting":
                        return null;
                    case "ready":
                        return {
                            phase: "ready",
                            model: server.connection.model,
                            connection: { provider: server.connection.provider, mode: server.connection.mode },
                        };
                    case "failed":
                        return {
                            phase: "failed",
                            message: server.bootError.message,
                            recovery: server.bootError.reason === SIGN_IN_REQUIRED ? "sign_in" : "boot_again",
                        };
                    default: {
                        const exhaustive: never = server;
                        throw new Error(`unhandled server phase: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (e): BootState => noServerState(e),
        );
        if (settled !== null) {
            readyServerStartedAt = settled.phase === "ready" && read.isOk() ? read.value.startedAt : null;
            setState(settled);
            return;
        }
        await opts.sleep(opts.pollMs);
    }
}

/** What {@link checkServer} reads: the server state, and the discovery file that names the server. Tests replace each one. */
export type ServerCheckOpts = BootWatchOpts & {
    /** The discovery file of this channel, or `null` when none is usable. Real: `readServerDiscovery`. */
    readonly readDiscovery: () => ServerDiscovery | null;
};

/** The production {@link ServerCheckOpts}. */
export const DEFAULT_SERVER_CHECK_OPTS: ServerCheckOpts = { ...DEFAULT_BOOT_WATCH_OPTS, readDiscovery: () => readServerDiscovery().unwrapOr(null) };

/**
 * The store state of a read that got no server state. An unreachable server gets the offer to start one. A
 * server that refused the read gets none: a start cannot change a refusal, and the message names it.
 */
function noServerState(e: ClientError): BootState {
    return e.type === "unreachable"
        ? { phase: "failed", message: describeClientError(e), recovery: "start_server" }
        : { phase: "failed", message: describeClientError(e) };
}

/**
 * Probe the server one time, at a tick of the chat poll, and keep the store true to it. Gives `true` when the
 * server that the store settled as ready still answers.
 *
 * - No answer while the store is ready: the store settles at `failed` with the `start_server` recovery,
 *   one time, thus the chat offers the start one time. The probe never starts a server itself, because
 *   the person can have stopped it on purpose.
 * - An answer while the store shows no server, or a boot failure that the server no longer has, or an
 *   answer of a different server (a new start time) while the store is ready: the store follows that
 *   boot again, thus the header, the sidebar, and the transcript read again at its `ready` edge.
 * - Each other case changes nothing. A boot that the store follows already reads the server itself.
 */
export async function checkServer(opts: ServerCheckOpts = DEFAULT_SERVER_CHECK_OPTS): Promise<boolean> {
    const read = await opts.readState();
    // Read after the await: the boot can change while the probe waits for its answer.
    const boot = state();
    if (read.isErr()) {
        if (boot.phase === "ready" && read.error.type === "unreachable") setState(noServerState(read.error));
        return false;
    }
    const server = read.value;
    switch (boot.phase) {
        case "ready":
            if (server.startedAt === readyServerStartedAt) return true;
            followServer(server, opts);
            return false;
        case "failed":
            if (boot.recovery === "start_server" || server.phase !== "failed") followServer(server, opts);
            return false;
        case "idle":
        case "booting":
            return false;
        default: {
            const exhaustive: never = boot;
            throw new Error(`unhandled boot phase: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/**
 * Follow the boot of a server that answered the probe, unless it speaks a different version of the HTTP API.
 * Then the store says so with the message of `ensureServer`, one time, and follows nothing: its routes can send
 * bodies that this client does not know.
 */
function followServer(server: ServerState, opts: ServerCheckOpts): void {
    if (server.apiVersion === API_VERSION) {
        void followBoot(opts);
        return;
    }
    const discovery = opts.readDiscovery();
    // No file names the server at this moment: the next tick probes again.
    if (discovery === null) return;
    const message = describeServerError({ type: "api_mismatch", discovery, state: server });
    const boot = state();
    if (boot.phase === "failed" && boot.message === message) return;
    readyServerStartedAt = null;
    setState({ phase: "failed", message });
}

/** How {@link recoverServerBoot} acts, and how it reads the boot after. Tests replace each one. */
export type BootRecoveryOpts = BootWatchOpts & {
    /** Run `inflexa up` in the terminal of the TUI, and settle at its exit. */
    readonly signIn: () => Promise<void>;
    /** `POST /api/v1/server/boot`. */
    readonly requestBoot: () => ResultAsync<ServerState, ClientError>;
    /**
     * Start a server, or find the one that a different client started: the spawn path of an `instance`
     * command (`ensureServer`). The error channel holds the message for the person.
     */
    readonly startServer: () => Promise<Result<void, string>>;
};

/** The production {@link BootRecoveryOpts} of the chat that `renderer` draws. */
export function bootRecoveryOpts(renderer: Pick<CliRenderer, "suspend" | "resume">): BootRecoveryOpts {
    return { ...DEFAULT_BOOT_WATCH_OPTS, signIn: () => signInInTerminal(renderer), requestBoot: () => requestServerBoot(), startServer: startServerFromChat };
}

/**
 * {@link ensureServer} for the chat. The renderer owns the terminal, thus the notice of the start is a toast,
 * and the stderr of `inflexa serve --detach` is read into the error instead of printed over the screen.
 */
async function startServerFromChat(): Promise<Result<void, string>> {
    const started = await ensureServer({
        ...DEFAULT_ENSURE_SERVER_OPTS,
        startServer: () => startDetachedServer("pipe"),
        notice: (line) => notify({ kind: "info", text: line }),
    });
    return started.map(() => undefined).mapErr(describeServerError);
}

/**
 * Act on the recovery of a failed boot, then read the server phase again until `ready` or `failed`. The sign-in
 * needs no boot request of its own: `inflexa up` sends it after a sign-in that succeeded. A boot request that the
 * server did not take settles the store as `failed` with nothing more to offer. A start of a server shows as
 * `booting` while it runs, and a start that failed offers the start again with its reason.
 */
export async function recoverServerBoot(recovery: BootRecovery, opts: BootRecoveryOpts): Promise<void> {
    switch (recovery) {
        case "sign_in":
            await opts.signIn();
            break;
        case "boot_again": {
            const requested = await opts.requestBoot();
            if (requested.isErr()) {
                setState({ phase: "failed", message: describeClientError(requested.error) });
                return;
            }
            break;
        }
        case "start_server": {
            // `booting` before the start: the start can wait up to 30 s for the answer of the new server, and a
            // probe of the poll in that time must not follow a second boot.
            setState({ phase: "booting" });
            const started = await opts.startServer();
            if (started.isErr()) {
                setState({ phase: "failed", message: started.error, recovery: "start_server" });
                return;
            }
            await followBoot(opts);
            return;
        }
        default: {
            const exhaustive: never = recovery;
            throw new Error(`unhandled boot recovery: ${String(exhaustive)}`);
        }
    }
    await watchServerBoot(opts);
}

/**
 * Run `inflexa up` in the terminal of the TUI: suspend the renderer, give the terminal to the child, then restore the
 * renderer. A failed run waits for Enter first, because the restore clears its output from the screen.
 */
async function signInInTerminal(renderer: Pick<CliRenderer, "suspend" | "resume">): Promise<void> {
    // With the raw mode off, Ctrl+C sends SIGINT to each process of the foreground group. The TUI has no handler of
    // its own, thus without this one a Ctrl+C that ends the sign-in also ends the chat.
    const ignoreInterrupt = (): void => undefined;
    process.on("SIGINT", ignoreInterrupt);
    renderer.suspend();
    const spawned = Result.fromThrowable(
        () => Bun.spawn({ cmd: selfInvocation(["up"]), stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
        (cause) => describeCause(cause),
    )();
    const code = spawned.isOk() ? await spawned.value.exited : null;
    if (code !== 0) await waitForEnter(spawned.isErr() ? `Could not run \`inflexa up\`: ${spawned.error}` : `\`inflexa up\` ended with exit code ${code}.`);
    renderer.resume();
    process.off("SIGINT", ignoreInterrupt);
}

/** Print `line`, then wait for one line of input. The renderer is suspended, thus the terminal is in its cooked mode. */
async function waitForEnter(line: string): Promise<void> {
    process.stdout.write(`\n  ${line}\n  Press Enter to go back to the chat.\n`);
    await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
        process.stdin.resume();
    });
    process.stdin.pause();
}

/** Test hook: drop the boot phase back to `idle`. Test-only. */
export function __resetBootForTest(): void {
    setState({ phase: "idle" });
    readyServerStartedAt = null;
    setAgentModels(EMPTY_AGENT_MODELS);
}

// ── Live per-agent model state ─────────────────────────────────────────────────────────────────────
//
// The status surface renders each user-facing agent's CURRENTLY-running model plus any pending (scheduled
// behind agent work) switch. The authority is the live agent switch of the server, which tracks swaps the
// one-time boot snapshot (`BootState.model`) cannot; this store mirrors `GET /api/v1/agents` into a
// reactive cell the TUI reads. Kept beside the boot store because the agent models ARE a boot-resolved fact and
// the affordance is gated on boot being ready — the same module the status surface already consults for
// runtime readiness. A SEPARATE signal from `BootState` because the models change AFTER `ready` (on a
// live switch) while the boot phase does not, so folding them into the `ready` variant would demand a
// phase transition on every model change.

/**
 * The live per-agent model state the status surface renders: each agent's currently-running model, and any
 * pending selection (persisted, scheduled behind in-flight agent work, not yet applied).
 */
export type AgentModelsState = {
    /** Each user-facing agent's model as it is RUNNING right now — empty strings until the runtime installs the switch. */
    readonly current: Readonly<Record<AgentName, string>>;
    /** Each agent's effort as it is RUNNING right now — `null` until the runtime installs the switch. */
    readonly efforts: Readonly<Record<AgentName, AgentEffort>> | null;
    /** Agents with a persisted selection not yet applied to the live runtime (a switch scheduled behind agent work). */
    readonly pending: ReadonlyMap<AgentName, AgentSelection>;
};

const EMPTY_AGENT_MODELS: AgentModelsState = { current: { conversation: "", sandbox: "", utility: "" }, efforts: null, pending: new Map() };

const [agentModelsState, setAgentModels] = createSignal<AgentModelsState>(EMPTY_AGENT_MODELS);

/** The live per-agent models + pending selections — read inside a tracking scope for reactivity. */
export const agentModels = agentModelsState;

/** The agent models of `list` as the store holds them. An agent with no current selection reads as an empty model. */
function agentModelsOf(list: AgentList): AgentModelsState {
    const current: Record<AgentName, string> = { conversation: "", sandbox: "", utility: "" };
    const efforts: Record<AgentName, AgentEffort> = { conversation: "high", sandbox: "medium", utility: "medium" };
    const pending = new Map<AgentName, AgentSelection>();
    let installed = true;
    for (const agent of list.agents) {
        if (agent.current === null) installed = false;
        else {
            current[agent.role] = agent.current.model;
            efforts[agent.role] = agent.current.effort;
        }
        if (agent.pending !== null) pending.set(agent.role, agent.pending);
    }
    return { current, efforts: installed ? efforts : null, pending };
}

/**
 * Read `GET /api/v1/agents` into the {@link agentModels} store. A failed read keeps the store as it is: the
 * next read edge reads again.
 */
export async function refreshAgentModels(readAgents: () => ResultAsync<AgentList, ClientError> = () => fetchAgents()): Promise<void> {
    (await readAgents()).match(
        (list) => setAgentModels(agentModelsOf(list)),
        () => undefined,
    );
}

/**
 * Mirror the live agent switch of the server into the {@link agentModels} store. Call ONCE from `App`'s
 * setup (inside its reactive owner). The server has no notification stream, thus the store reads
 * `GET /api/v1/agents` on the read edges: the `ready` edge of the boot, and the edge where the chat stops
 * being busy, because a switch that waits for idle lands when the agent work settles. The picker reads it
 * again after its own save.
 */
export function watchAgentModels(readAgents: () => ResultAsync<AgentList, ClientError> = () => fetchAgents()): void {
    createEffect(() => {
        if (state().phase === "ready") void refreshAgentModels(readAgents);
    });
    createEffect(
        on(chatStatus, (now, before) => {
            if (before === "busy" && now !== "busy" && state().phase === "ready") void refreshAgentModels(readAgents);
        }),
    );
}

/** Test hook: set the agent-models store directly (no runtime, no switch). Test-only. */
export function __setAgentModelsForTest(next: AgentModelsState): void {
    setAgentModels(next);
}

/** Test hook: drive the boot phase directly (e.g. seed a `ready` state with a connection). Test-only. */
export function __setBootStateForTest(next: BootState): void {
    setState(next);
}
