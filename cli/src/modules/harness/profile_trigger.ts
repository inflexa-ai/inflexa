import { loadDataProfileStatus, reconcileOrphanedDataProfile, triggerDataProfile } from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { Analysis } from "../../types/analysis.ts";
import { sessionTreeDataDir } from "../staging/paths.ts";
import { stageInputs } from "../staging/staging.ts";
import { seedProfileLedger } from "./profile.ts";
import type { HarnessRuntime } from "./runtime.ts";

// The headless data-profile parity check (design D8). The TUI auto-triggers a profile at managed
// parity when a chat opens on `ready` (and after an analysis swap); this module owns the DECISION —
// staging + the trigger sequence — and returns a discriminated outcome. It writes NO terminal/TUI
// output: the reactive hook (`tui/hooks/profile_parity.ts`) maps the outcome to a notice. The
// stage → seed → trigger core is shared with `inflexa profile` (`seedProfileLedger` in profile.ts),
// so the ledger contract stays single-sourced.

/**
 * The outcome of a parity check, as a discriminated union the caller maps to UI feedback:
 * - `triggered` — a profile workflow was started (or re-started) for this analysis;
 * - `already_profiled` — a completed profile exists, so nothing was triggered;
 * - `already_running` — a profile is already in flight (either the ledger showed `running` up front,
 *   or the trigger's CAS reported another attempt won), so nothing new was triggered;
 * - `no_inputs` — the analysis has no resolvable inputs (empty staged manifest); skipped silently;
 * - `failed` — a step failed (ledger read, staging, seed, or the trigger itself); `reason` is a
 *   one-line, user-facing explanation the caller surfaces as a warning.
 */
export type ProfileParityOutcome =
    { kind: "triggered" } | { kind: "already_profiled" } | { kind: "already_running" } | { kind: "no_inputs" } | { kind: "failed"; reason: string };

/**
 * The effectful seams, injectable so the condition-ladder tests run offline (no Postgres, no Docker,
 * no model). Production callers pass nothing and get the real harness reads + staging + the shared
 * `seedProfileLedger`. The `seed`/`trigger` seams are the same functions `inflexa profile` drives, so
 * a test exercising the happy path with the real `seed` asserts the exact params the command builds.
 */
export type ProfileParitySeams = {
    readonly reconcile: typeof reconcileOrphanedDataProfile;
    readonly loadStatus: typeof loadDataProfileStatus;
    readonly stage: typeof stageInputs;
    readonly seed: typeof seedProfileLedger;
    readonly trigger: typeof triggerDataProfile;
};

const realParitySeams: ProfileParitySeams = {
    reconcile: reconcileOrphanedDataProfile,
    loadStatus: loadDataProfileStatus,
    stage: stageInputs,
    seed: seedProfileLedger,
    trigger: triggerDataProfile,
};

/**
 * Auto-trigger the data profile at parity for `analysis`, fire-and-forget (design D8). The ladder:
 *
 *   0. Reconcile an orphaned ledger row (best-effort) — a prior run that died between the CAS and its
 *      DBOS workflow insert leaves the row wedged at `running` with nothing to resume; boot has run
 *      DBOS recovery, so a still-`running` row with no workflow is genuinely orphaned. Reset it so the
 *      status read below re-triggers instead of reporting `already_running` forever. Mirrors
 *      `inflexa profile` (`runProfile` in profile.ts), so the TUI open path self-heals the same way.
 *   1. Read the ledger status — a completed or running profile is a skip (`already_profiled` /
 *      `already_running`); a ledger read fault is `failed` (parity can't be judged).
 *   2. Stage the analysis's inputs into its session data dir — an empty manifest is `no_inputs`
 *      (the welcome hint already covers "add inputs"), a staging fault is `failed`.
 *   3. Seed the ledger + build the trigger params via the shared {@link seedProfileLedger}.
 *   4. Trigger the workflow; map the harness result to `triggered` / `already_running` / `failed`.
 *
 * Chat is never gated on the profile (Cortex parity), so this returns as soon as the trigger is
 * dispatched — it never waits for completion. NO terminal/TUI output: the caller maps the outcome.
 */
export async function ensureProfileAtParity(
    runtime: HarnessRuntime,
    analysis: Analysis,
    seams: ProfileParitySeams = realParitySeams,
): Promise<ProfileParityOutcome> {
    // Best-effort self-heal of a wedged `running` row (step 0 above); a reconcile hiccup must not
    // abort parity — the status read still runs and the trigger's CAS remains the final arbiter.
    (await seams.reconcile(runtime.pool, analysis.id)).match(
        () => {},
        (e) => getLogger("harness").warn({ analysisId: analysis.id, err: e }, "orphaned-profile reconcile failed"),
    );

    const statusResult = await seams.loadStatus(runtime.pool, analysis.id);
    if (statusResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${statusResult.error.type})` };
    const status = statusResult.value;
    // Only a completed or an in-flight profile skips; `pending`/`failed`/absent all fall through to
    // (re-)trigger — the same set the command's trigger CAS re-claims.
    if (status?.status === "completed") return { kind: "already_profiled" };
    if (status?.status === "running") return { kind: "already_running" };

    const stageResult = await seams.stage(analysis.id, sessionTreeDataDir(analysis.id));
    if (stageResult.isErr()) return { kind: "failed", reason: `staging inputs failed (${stageResult.error.type})` };
    const staged = stageResult.value;
    if (staged.length === 0) return { kind: "no_inputs" };

    const seedResult = await seams.seed(runtime.pool, analysis.id, staged);
    if (seedResult.isErr()) return { kind: "failed", reason: `could not seed the analysis state (${seedResult.error.type})` };
    const params = seedResult.value;

    const result = await seams.trigger(runtime.triggerDeps, params);
    switch (result) {
        case "started":
        case "restarted":
            return { kind: "triggered" };
        case "already_running":
            return { kind: "already_running" };
        case "failed":
            // Unlike the command, this path does not attempt the retry-claim + re-run (that flow is
            // interwoven with clack narration); reporting `failed` lets the UI surface it and the user
            // re-open or run `inflexa profile` to retry.
            return { kind: "failed", reason: "the profile workflow could not be started" };
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled trigger result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
