import { createEffect, createSignal, onCleanup } from "solid-js";

import type { ModelConnectionIdentity, ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import { bootHarnessRuntime, type HarnessRuntime } from "../../modules/harness/runtime.ts";
import { describeBootError } from "../../modules/harness/profile.ts";
import { currentAgentModels, onAgentStateChange, pendingAgentSelections, type AgentName } from "../../modules/harness/agent_switch.ts";

// The embedded harness runtime's boot lifecycle as seen by the chat UI, held here (not inside
// `app.tsx`) so the holder is decoupled from its renderer — the launcher DRIVES it
// (`startHarnessBoot` post-render) while `app.tsx` only READS the phase to gate submits, paint the
// status bar, and mount the boot animation. Mirrors the `status.ts` / `theme.ts` store shape (a
// reactive accessor + a single indirect mutator). One chat screen boots at a time, so a module
// singleton is correct. The runtime HANDLE is deliberately NOT in the signal: it is infrastructure
// (pools, DBOS deps, the conversation agent), nothing in the view reacts to the handle itself, and
// keeping it out of a signal means acquiring it schedules no repaint — the same reasoning
// `runtime.ts` uses to keep its process singleton outside any reactive cell.

/**
 * The boot phase surfaced to the chat UI:
 * - `idle` — no boot kicked off yet (the first frame before the launcher fires `startHarnessBoot`);
 * - `booting` — `bootHarnessRuntime` is in flight; the input is gated and the animation renders;
 * - `ready` — the runtime handle exists, carrying the conversation agent's resolved `model` (a one-time
 *   boot snapshot) and the shared `connection` identity (provider slug + mode) the status surface renders;
 * - `failed` — boot could not complete, carrying the boot-error taxonomy's actionable `message` as a
 *   TERMINAL state (never a hang): the user reads the remedy and quits cleanly.
 *
 * The connection rides the `ready` variant — not the swap-tracking {@link agentModels} store — because it
 * is a boot-resolved, immutable fact (a live agent-model swap never changes the connection — both agents
 * share one connection, so a swap changes only a model), so it is seeded ONCE at the ready edge, exactly
 * matching this variant's set-once-and-never-mutate lifecycle.
 */
export type BootState =
    { phase: "idle" } | { phase: "booting" } | { phase: "ready"; model: string; connection: ModelConnectionIdentity } | { phase: "failed"; message: string };

const [state, setState] = createSignal<BootState>({ phase: "idle" });

/** Read the current boot phase — call inside a tracking scope for reactivity. */
export const bootState = state;

// Non-reactive infrastructure handle (see the module note above): set once on `ready`, read by the
// turn engine, never observed for repaints.
let runtime: HarnessRuntime | null = null;

/** The booted runtime handle, or `null` until boot reaches `ready`. Non-reactive infrastructure. */
export function harnessRuntime(): HarnessRuntime | null {
    return runtime;
}

/**
 * The boot driver, injectable so the store's transition tests run offline (no Postgres, no DBOS,
 * no proxy). Production callers pass nothing and the real {@link bootHarnessRuntime} runs.
 */
export type BootDriver = typeof bootHarnessRuntime;

/**
 * Kick off the embedded harness runtime boot and publish its transitions to the boot store. Drives
 * {@link bootHarnessRuntime} with the resolved config: the phase moves `booting → ready | failed`,
 * the handle is stashed on success, and a failure is mapped through {@link describeBootError} into
 * the one actionable line the gate UI renders.
 *
 * Idempotent while in flight or settled-ready: a call whose current phase is already `booting` or
 * `ready` is a no-op, so the launcher may fire it once post-render (fire-and-forget) without
 * guarding against a double-open. `driver` is injected only by tests.
 */
export async function startHarnessBoot(config: ResolvedHarnessConfig, driver: BootDriver = bootHarnessRuntime): Promise<void> {
    const phase = state().phase;
    // Synchronous up to the `setState` below (no `await` before it), so a second call within the
    // same JS turn already observes `booting` — the guard needs no extra in-flight flag.
    if (phase === "booting" || phase === "ready") return;
    setState({ phase: "booting" });
    const result = await driver({ config });
    result.match(
        (rt) => {
            runtime = rt;
            // `model` snapshots the conversation agent's boot model; both agents' LIVE models render from the
            // `agentModels` store. `connection` is the shared connection's identity, seeded here at
            // the ready edge and immutable thereafter (a swap changes only a model, never the shared
            // connection), so the sidebar surfaces it beside the agents.
            setState({ phase: "ready", model: rt.conversation.model, connection: rt.connection });
        },
        (e) => setState({ phase: "failed", message: describeBootError(e) }),
    );
}

/** Test hook: drop the boot phase and handle back to `idle` without shutting anything down. Test-only. */
export function __resetBootForTest(): void {
    runtime = null;
    setState({ phase: "idle" });
    setAgentModels(EMPTY_AGENT_MODELS);
}

// ── Live per-agent model state ─────────────────────────────────────────────────────────────────────
//
// The status surface renders each user-facing agent's CURRENTLY-running model plus any pending (scheduled
// behind agent work) switch. The authority is the live agent switch (`agent_switch.ts`), which tracks
// swaps the one-time boot snapshot (`BootState.model`) cannot; this store mirrors it into a reactive
// cell the TUI reads. Kept beside the boot store because the agent models ARE a boot-resolved fact and
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
    /** Agents with a persisted selection not yet applied to the live runtime (a switch scheduled behind agent work). */
    readonly pending: ReadonlyMap<AgentName, string>;
};

const EMPTY_AGENT_MODELS: AgentModelsState = { current: { conversation: "", sandbox: "" }, pending: new Map() };

const [agentModelsState, setAgentModels] = createSignal<AgentModelsState>(EMPTY_AGENT_MODELS);

/** The live per-agent models + pending selections — read inside a tracking scope for reactivity. */
export const agentModels = agentModelsState;

/**
 * Mirror the live agent switch into the {@link agentModels} store. Call ONCE from `App`'s setup (inside its
 * reactive owner). Adapts the switch's plain `onAgentStateChange` callback to a Solid signal (a subscribe
 * paired with `onCleanup`, per CLAUDE.md), and seeds the initial values at the `ready` edge — the seam
 * carries real values only after `installAgentSwitch` ran during boot, and `onAgentStateChange` fires only
 * on a LATER change, so the first values must be pulled when boot reaches `ready`.
 */
export function watchAgentModels(): void {
    const refresh = (): void => {
        setAgentModels({ current: currentAgentModels(), pending: pendingAgentSelections() });
    };
    const unsub = onAgentStateChange(refresh);
    onCleanup(unsub);
    createEffect(() => {
        if (state().phase === "ready") refresh();
    });
}

/** Test hook: set the agent-models store directly (no runtime, no switch). Test-only. */
export function __setAgentModelsForTest(next: AgentModelsState): void {
    setAgentModels(next);
}

/** Test hook: drive the boot phase directly (e.g. seed a `ready` state with a connection). Test-only. */
export function __setBootStateForTest(next: BootState): void {
    setState(next);
}
