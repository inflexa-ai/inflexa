import { createEffect, createSignal, on } from "solid-js";
import type { ResultAsync } from "neverthrow";

import type { AgentEffort, AgentList, AgentName, AgentSelection } from "../../api/machine.ts";
import type { ServerConnection, ServerState } from "../../api/server.ts";
import { describeClientError, type ClientError } from "../../client/api.ts";
import { fetchAgents } from "../../client/machine.ts";
import { fetchServerState } from "../../client/server.ts";
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
 * - `failed` — the boot failed, or no server answered, carrying one actionable `message` as a TERMINAL
 *   state (never a hang): the user reads the remedy and quits cleanly.
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
    | { phase: "failed"; message: string };

const [state, setState] = createSignal<BootState>({ phase: "idle" });

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
    // Synchronous up to the `setState` below (no `await` before it), so a second call within the
    // same JS turn already observes `booting` — the guard needs no extra in-flight flag.
    if (phase === "booting" || phase === "ready") return;
    setState({ phase: "booting" });
    for (;;) {
        const settled = (await opts.readState()).match(
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
                        return { phase: "failed", message: server.bootError.message };
                    default: {
                        const exhaustive: never = server;
                        throw new Error(`unhandled server phase: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
            (e): BootState => ({ phase: "failed", message: describeClientError(e) }),
        );
        if (settled !== null) {
            setState(settled);
            return;
        }
        await opts.sleep(opts.pollMs);
    }
}

/** Test hook: drop the boot phase back to `idle`. Test-only. */
export function __resetBootForTest(): void {
    setState({ phase: "idle" });
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
