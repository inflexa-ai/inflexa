import { randomUUIDv7 } from "bun";
import type { ChatProvider } from "@inflexa-ai/harness";

import { Bus } from "../../lib/bus.ts";
import type { StampedEvent } from "../../types/events.ts";
import type { ProvModelId } from "../../types/prov.ts";
import { AGENT_NAMES, type AgentName } from "./config.ts";

// The live agent-model switch (agent-model-selection D4). Two cooperating pieces live here because they
// are one decision: an agent-work GAUGE that reads whether any agent work is in flight, and the
// pending-selection CONTROLLER that applies a persisted agent pick either immediately (gauge idle) or
// at the moment the LAST in-flight work settles (gauge busy). Both are process singletons — there is
// one embedded runtime per process (`runtime.ts`), so one gauge and one controller.
//
// The mechanism is reconstruction-at-idle, never a mid-flight field flip. Application rebuilds the
// affected agent's provider instance and — for the sandbox agent — its provenance emitters WITH the new
// `{provider}/{model}` name (preserving PR #70's construction-time-stamping contract), then swaps them
// atomically while the gauge is idle so no request observes a mix. The registered DBOS workflows are
// NOT re-registered: they reach the swapped objects through stable delegating handles (the agent's
// {@link SwappableChatProvider}) and through the deps-bundle fields they read lazily per-invocation
// (the emitters, re-pointed by the `swapSandboxEmitters` closure the boot supplies). In-flight work
// keeps the instances it started with because the swap waits for idle.

/**
 * A {@link ChatProvider} whose delegated inner target can be swapped at runtime. The agent's provider on
 * the composition, the run-engine deps bundles, the conversation agent's sub-agents, and the streaming
 * chat wrapper all capture THIS stable reference, so a single {@link SwappableChatProvider.swap} at the
 * idle transition re-points every one of them at once. Both `chat` and `chatStream` read the current
 * inner at CALL time, so a wrapper built once (e.g. `createStreamingChat`) follows the swap.
 */
export type SwappableChatProvider = ChatProvider & {
    /**
     * Replace the delegated inner target. Called ONLY at the idle transition (tasks 3.2/3.3) — the
     * caller (the controller) swaps while {@link isAgentWorkIdle} holds, so no in-flight request ever
     * observes a mid-flight change of model.
     */
    swap(next: ChatProvider): void;
    /**
     * The live inner target. Introspection only — production reads an agent's current model from
     * {@link currentAgentModels}, never by unwrapping this. Kept so the D-SHARE invariant (coincident
     * agents share ONE underlying provider instance) stays assertable through the per-agent wrappers.
     */
    readonly current: ChatProvider;
};

/**
 * Wrap a provider so its inner target can be swapped later. `capabilities` reads through to the current
 * inner; both agent providers advertise `{ toolCalling: true }`, so the value is stable across swaps and
 * a consumer that snapshots it (`createStreamingChat`) stays correct.
 */
export function createSwappableProvider(initial: ChatProvider): SwappableChatProvider {
    let inner = initial;
    return {
        get capabilities() {
            return inner.capabilities;
        },
        get current() {
            return inner;
        },
        chat(req, session, signal) {
            return inner.chat(req, session, signal);
        },
        chatStream(req, session, signal) {
            return inner.chatStream(req, session, signal);
        },
        swap(next) {
            inner = next;
        },
    };
}

/**
 * The live inner provider behind a possibly-swappable handle, or the provider itself when it is a plain
 * one. Lets a caller compare the UNDERLYING instances of two agent handles (the D-SHARE composition
 * invariant) without unwrapping the delegating wrapper by hand.
 */
export function agentProviderInner(provider: ChatProvider): ChatProvider {
    return "current" in provider && "swap" in provider ? (provider as SwappableChatProvider).current : provider;
}

// ---- Agent-work gauge (task 3.1) ----------------------------------------------------------------

// One token per discrete unit of in-flight agent work. Idle ⇔ empty. A Set keyed by a stable id makes
// enter/leave idempotent, which is what lets DBOS recovery re-emit `run_started` for a reclaimed run
// without double-counting it. Kinds and their tokens:
//   chat turn      `chat-turn:<uuid>`     — bracketed in `runChatTurn` (covers ephemeral: `run_ephemeral`
//                                            is `launchAndAwait`, so it settles inside the turn, and the
//                                            boot ephemeral sweep cancels recovery-orphaned ones).
//   analysis run   `run:<runId>`          — driven by the `prov.run_started`/`prov.run_completed` bus,
//                                            which covers cli-launched, chat-launched (`execute_plan`,
//                                            outliving its turn), AND DBOS-recovered runs (re-emitted).
//   data profile   `data-profile:<id>`    — fed by a host observer via `noteDataProfileState` (see its
//                                            doc for why this channel is push-fed rather than self-owned).
const inFlightWork = new Set<string>();

// Fired once each time the LAST in-flight work settles (the set transitions to empty). The controller
// subscribes to apply pending selections; a plain callback so nothing here depends on the TUI.
const idleListeners = new Set<() => void>();

/**
 * Whether NO agent work is in flight. The switch's gate: a selection applies immediately only when this
 * is true, and a pending selection lands the moment this becomes true. Any kind the gauge cannot observe
 * is left to fail closed by its own channel (a data profile stays busy until its host observer clears it
 * — see {@link noteDataProfileState}); the gauge never invents idleness.
 */
export function isAgentWorkIdle(): boolean {
    return inFlightWork.size === 0;
}

function enterWork(token: string): void {
    inFlightWork.add(token);
}

function leaveWork(token: string): void {
    // Unknown token → no-op: an idempotent leave never drives the set below the work actually present.
    if (!inFlightWork.delete(token)) return;
    if (inFlightWork.size === 0) {
        // Snapshot first: an idle handler applies a swap, which adds no work, but copying keeps the
        // iteration robust against a listener unsubscribing mid-notify.
        for (const cb of [...idleListeners]) cb();
    }
}

/**
 * Register a callback fired each time the gauge transitions to idle (the last in-flight work settled).
 * Internal to the switch — the controller uses it to drain pending selections. Returns an unsubscribe.
 */
function onAgentWorkIdle(cb: () => void): () => void {
    idleListeners.add(cb);
    return () => {
        idleListeners.delete(cb);
    };
}

/**
 * Bracket one chat turn as in-flight work. Called by `runChatTurn` (the shared turn engine both the TUI
 * and REPL drive), so a switch requested mid-turn defers to the turn boundary: the returned `leave`
 * runs in the turn's `finally`, and if it empties the gauge the pending switch lands before the next
 * turn begins. Idempotent — a double `leave` is safe.
 */
export function enterChatTurn(): () => void {
    const token = `chat-turn:${randomUUIDv7()}`;
    enterWork(token);
    let left = false;
    return () => {
        if (left) return;
        left = true;
        leaveWork(token);
    };
}

/**
 * Report a data profile's run state into the gauge. Push-fed by a host observer (the TUI's live
 * data-profile status watch — agent-model-selection group 4) rather than owned here, because the data
 * profile is a fire-and-forget DBOS workflow (`DBOS.startWorkflow`, handle not surfaced) that emits NO
 * `prov.*` bus events, so its running phase is observable ONLY through the `cortex_analysis_state`
 * ledger — which a synchronous gauge cannot read at decision time. The runtime module therefore cannot
 * self-observe a profile the way it observes runs (bus) and chat turns (call-site bracket); it exposes
 * THIS seam so the surface that already polls that ledger feeds start/settle. Absent such a feed a
 * post-boot profile is untracked — a documented boundary the group-4 status wiring closes.
 */
export function noteDataProfileState(analysisId: string, running: boolean): void {
    const token = `data-profile:${analysisId}`;
    if (running) enterWork(token);
    else leaveWork(token);
}

/** Test hook: drop all gauge state (tokens + idle listeners). Test-only. */
export function __resetGaugeForTest(): void {
    inFlightWork.clear();
    idleListeners.clear();
}

// ---- Pending-selection controller + public seam (tasks 3.2/3.3) ---------------------------------

/**
 * The boot-supplied wiring the switch reconstructs through. The boot owns provider construction and the
 * emitter re-point (both need construction details — connection, key, deps references — that stay in
 * `runtime.ts`); the switch owns the WHEN. Passed once to {@link installAgentSwitch}.
 */
export type AgentSwitchWiring = {
    /** Each agent's stable delegating provider handle — the object every consumer captured; swapping its inner is the agent swap. */
    readonly swappable: Readonly<Record<AgentName, SwappableChatProvider>>;
    /** Construct a fresh inner {@link ChatProvider} bound to `model` over the shared connection (the boot's own construction path). */
    readonly rebuildProvider: (model: string) => ChatProvider;
    /**
     * Re-point the sandbox agent's provenance emitters (artifact registry + run-lifecycle emitter) at
     * new instances constructed WITH `name`. Supplied by the boot because it holds the registered deps
     * bundles those emitters live on; the workflows read them lazily, so a re-point at idle re-stamps
     * every FUTURE step while in-flight steps keep theirs.
     */
    readonly swapSandboxEmitters: (name: ProvModelId) => void;
    /** The connection's provider slug — constant across an agent swap (D-SHARE: one connection), so only the model half of the provenance name changes. */
    readonly modelProvider: string;
    /** The models each agent booted on — the switch's starting `current` state. */
    readonly initialModels: Readonly<Record<AgentName, string>>;
};

type ActiveSwitch = {
    readonly wiring: AgentSwitchWiring;
    /** The model each agent is CURRENTLY running (updated the instant a swap applies). */
    readonly current: Record<AgentName, string>;
    /** Agents with a persisted selection not yet applied to the live runtime (busy at request time). */
    readonly pending: Map<AgentName, string>;
    /** Detach the run-bus tracking + idle-drain subscriptions installed for this runtime. */
    readonly detach: () => void;
};

let active: ActiveSwitch | null = null;

// Group-4 (TUI) reactors, notified on any current/pending change. Module-level so they survive the
// callback registration pattern; cleared when the runtime tears down.
const stateListeners = new Set<() => void>();

function notifyStateChange(): void {
    for (const cb of [...stateListeners]) cb();
}

/**
 * Apply an agent selection to the live runtime NOW (the caller guarantees the gauge is idle): rebuild the
 * agent's provider inner and swap it into the stable handle; for the sandbox agent also re-point its
 * provenance emitters so subsequent step/command events carry the new `{provider}/{model}` name. The
 * conversation agent has no provenance emitter (chat turns write the Solid store, not the bus), so only
 * its provider swaps. Mutates `current` and clears any `pending` for the agent.
 */
function applyAgent(state: ActiveSwitch, agent: AgentName, model: string): void {
    state.wiring.swappable[agent].swap(state.wiring.rebuildProvider(model));
    if (agent === "sandbox") {
        state.wiring.swapSandboxEmitters(`${state.wiring.modelProvider}/${model}`);
    }
    state.current[agent] = model;
    state.pending.delete(agent);
}

/** Drain every pending selection at the idle transition. No-op when nothing is pending. */
function applyPending(state: ActiveSwitch): void {
    if (state.pending.size === 0) return;
    for (const [agent, model] of [...state.pending]) applyAgent(state, agent, model);
    notifyStateChange();
}

/**
 * Install the switch over a freshly-booted runtime's wiring (called once per boot, BEFORE `launchDbos`
 * so the run-bus subscription catches DBOS recovery's re-emitted `run_started`). Subscribes the gauge's
 * run tracking to the bus and its pending drain to the idle transition. Replaces any prior install
 * (a re-boot after teardown).
 */
export function installAgentSwitch(wiring: AgentSwitchWiring): void {
    if (active) active.detach();

    const runBusHandler = (event: StampedEvent): void => {
        // Runs are the one kind observed purely through the bus: `run_started`/`run_completed` fire from
        // the execute-analysis body at both terminal boundaries (success AND failure) and re-fire on
        // recovery, so the run-id Set stays accurate without a call-site bracket.
        if (event.type === "prov.run_started") enterWork(`run:${event.run.runId}`);
        else if (event.type === "prov.run_completed") leaveWork(`run:${event.outcome.runId}`);
    };
    Bus.on("inflexa", runBusHandler);

    const state: ActiveSwitch = {
        wiring,
        current: { ...wiring.initialModels },
        pending: new Map(),
        detach: () => {
            Bus.off("inflexa", runBusHandler);
            unsubIdle();
        },
    };
    const unsubIdle = onAgentWorkIdle(() => applyPending(state));
    active = state;
}

/**
 * Tear down the switch for the current runtime: detach its bus + idle subscriptions, drop its
 * pending/current state, clear the reactors, and reset the gauge (a fresh runtime starts with a clean
 * gauge). Called from the runtime's shutdown hook and on a failed boot.
 */
export function clearAgentSwitch(): void {
    if (active) active.detach();
    active = null;
    stateListeners.clear();
    inFlightWork.clear();
}

/**
 * Apply — or schedule — an agent model change on the LIVE runtime (agent-model-selection D4). Assumes the
 * caller already persisted the pick to `models.agents.<agent>` (config is the durable truth; this handles
 * only the runtime application). Returns `applied` when the change took effect immediately (the gauge
 * was idle, or the model already matched), or `scheduled` when it was recorded pending because agent
 * work is in flight — it will apply the moment the last in-flight work settles. A change requested with
 * no live runtime is reported `scheduled`: nothing runs to apply it to, and the next boot reads the
 * persisted config.
 */
export function requestAgentModelChange(agent: AgentName, model: string): { status: "applied" } | { status: "scheduled" } {
    const state = active;
    if (!state) return { status: "scheduled" };

    // Already on this model: clear any stale pending for the agent and report applied — the runtime
    // needs no work, and a lingering pending would misreport the agent as mid-switch.
    if (state.current[agent] === model && !state.pending.has(agent)) return { status: "applied" };
    if (state.current[agent] === model) {
        state.pending.delete(agent);
        notifyStateChange();
        return { status: "applied" };
    }

    if (isAgentWorkIdle()) {
        applyAgent(state, agent, model);
        notifyStateChange();
        return { status: "applied" };
    }
    state.pending.set(agent, model);
    notifyStateChange();
    return { status: "scheduled" };
}

/**
 * The model each agent is CURRENTLY running — the live authority the status surface renders (it tracks
 * swaps, unlike the boot store's one-time snapshot). Empty strings before a runtime installs (the
 * palette/status are boot-gated, so callers see real values).
 */
export function currentAgentModels(): Record<AgentName, string> {
    if (!active) return { conversation: "", sandbox: "" };
    return { ...active.current };
}

/**
 * The agents with a selection persisted but not yet applied to the live runtime (a switch scheduled
 * behind in-flight work), as a readonly snapshot. Empty when nothing is pending.
 */
export function pendingAgentSelections(): ReadonlyMap<AgentName, string> {
    if (!active) return new Map();
    return new Map(active.pending);
}

/**
 * Subscribe to agent-state changes (a swap applied, or a selection scheduled/cleared) with a plain
 * callback — the TUI adapts this to Solid itself. Returns an unsubscribe. Fires AFTER the state has
 * updated, so a handler reads the new {@link currentAgentModels}/{@link pendingAgentSelections}.
 */
export function onAgentStateChange(cb: () => void): () => void {
    stateListeners.add(cb);
    return () => {
        stateListeners.delete(cb);
    };
}

// Re-exported so a caller iterating the agents stays aligned with the config's closed agent set.
export { AGENT_NAMES, type AgentName };
