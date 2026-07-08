import { createEffect, on } from "solid-js";

import { GLYPHS } from "../../lib/design_system.ts";
import { ensureProfileAtParity } from "../../modules/harness/profile_trigger.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { Analysis } from "../../types/analysis.ts";
import type { Workspace } from "../contexts/workspace.ts";
import { bootState, harnessRuntime } from "./boot.ts";
import { notify } from "./notice.ts";

// The data-profile parity auto-trigger's reactive side (design D8), held here (not inside app.tsx) so
// the wiring lives beside the boot/notice hooks it reads. `watchProfileParity` is an app-level hook
// App calls once in setup; the fire-and-forget driver + the de-dup memory are module state — the same
// singleton shape as status.ts / notice.ts, correct because one chat screen is mounted at a time.

// The analysis id we last fired a parity check for. Module state so a repaint or a settled boot phase
// never re-fires for an analysis already handled; a genuine swap to a different id fires again. A
// re-open of the same id after swapping away is harmless — the helper reports already_running /
// already_profiled, which the driver treats as a silent skip.
let lastTriggeredAnalysisId: string | null = null;

/** Test hook: forget the last-triggered analysis so the de-dup guard starts clean. Test-only. */
export function __resetProfileParityForTest(): void {
    lastTriggeredAnalysisId = null;
}

/**
 * Reactively auto-trigger the data-profile parity check (design D8). Fires the fire-and-forget helper
 * when boot reaches `ready` and again whenever the workspace analysis changes post-ready (an
 * in-place analysis swap), mapping the outcome to a notice: `triggered` → info, `failed` → warn;
 * `no_inputs`/`already_*` are silent (managed parity — a running/completed/input-less analysis is
 * normal). It NEVER fires before `ready` (no runtime to trigger against) and de-dupes per analysis id
 * so a repaint or a boot-phase settle does not re-fire. Called once from App's setup body.
 */
export function watchProfileParity(workspace: Workspace): void {
    createEffect(
        on(
            () => [bootState().phase, workspace.analysis?.id ?? null] as const,
            ([phase, analysisId]) => {
                if (phase !== "ready" || analysisId === null) return;
                if (analysisId === lastTriggeredAnalysisId) return;
                // `ready` guarantees a booted runtime handle; the analysis is the store's, re-read here
                // (not the destructured id) so the driver holds the object, not just its id.
                const runtime = harnessRuntime();
                const analysis = workspace.analysis;
                if (!runtime || !analysis) return;
                lastTriggeredAnalysisId = analysisId;
                void driveProfileParity(runtime, analysis);
            },
        ),
    );
}

/** Run the helper and map its outcome onto the notice channel; skips stay silent (design D8). */
async function driveProfileParity(runtime: HarnessRuntime, analysis: Analysis): Promise<void> {
    const outcome = await ensureProfileAtParity(runtime, analysis);
    switch (outcome.kind) {
        case "triggered":
            notify({ kind: "info", text: `Profiling "${analysis.name}" data${GLYPHS.ellipsis}` });
            return;
        case "failed":
            notify({ kind: "warn", text: `Could not start profiling "${analysis.name}": ${outcome.reason}` });
            return;
        case "already_profiled":
        case "already_running":
        case "no_inputs":
            return;
        default: {
            const _exhaustive: never = outcome;
            throw new Error(`unhandled parity outcome: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
