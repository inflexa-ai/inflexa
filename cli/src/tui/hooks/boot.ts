import { createSignal } from "solid-js";

import type { ResolvedHarnessConfig } from "../../modules/harness/config.ts";
import { bootHarnessRuntime, type HarnessRuntime } from "../../modules/harness/runtime.ts";
import { describeBootError } from "../../modules/harness/profile.ts";

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
 * - `ready` — the runtime handle exists (carrying the resolved chat `model` for the status affordance);
 * - `failed` — boot could not complete, carrying the boot-error taxonomy's actionable `message` as a
 *   TERMINAL state (never a hang): the user reads the remedy and quits cleanly.
 */
export type BootState = { phase: "idle" } | { phase: "booting" } | { phase: "ready"; model: string } | { phase: "failed"; message: string };

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
            setState({ phase: "ready", model: rt.model });
        },
        (e) => setState({ phase: "failed", message: describeBootError(e) }),
    );
}

/** Test hook: drop the boot phase and handle back to `idle` without shutting anything down. Test-only. */
export function __resetBootForTest(): void {
    runtime = null;
    setState({ phase: "idle" });
}
