import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
    clearDataProfile,
    loadDataProfileStatus,
    reconcileOrphanedDataProfile,
    runDataProfile,
    triggerDataProfile,
    tryRetryDataProfile,
    type DataProfileTriggerParams,
} from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { Analysis } from "../../types/analysis.ts";
import { sessionTreeDataDir } from "../staging/paths.ts";
import { enumerateInputFileIds, stageInputs } from "../staging/staging.ts";
import { seedProfileLedger } from "./profile.ts";
import type { HarnessRuntime } from "./runtime.ts";

// The headless data-profile parity checks (design D8). Two entry points, both writing NO terminal/TUI
// output — the reactive hook (`tui/hooks/profile_parity.ts`) maps their discriminated outcome to a
// notice: `ensureProfileAtParity` is the managed auto-check the TUI fires when a chat opens on `ready`
// (and after an analysis swap); `forceReprofile` is the deliberate re-profile the palette/dialog action
// drives. Both own the DECISION — enumerate → (drift/status branch) → stage → seed → trigger — and share
// the stage → seed core with `inflexa profile` (`seedProfileLedger` in profile.ts), so the ledger
// contract stays single-sourced. The cheap `enumerateInputFileIds` runs FIRST so the drift check costs
// only stat/readdir; `stageInputs` (content hashing) runs ONLY once a (re-)trigger has been decided.

/**
 * The outcome of a parity (or force) check, as a discriminated union the caller maps to UI feedback:
 * - `triggered` — a profile workflow was started; `restarted` is true iff it superseded a prior profile
 *   (a re-profile / retry), so the UI can word "Re-profiling…" vs a first-time "Profiling…";
 * - `already_profiled` — a completed profile already covers exactly the current input set, so nothing ran;
 * - `already_running` — a profile is already in flight (the ledger showed `running`, the trigger's CAS
 *   lost to another attempt, or a clear/retry raced a run that had just started), so nothing new ran;
 * - `cleared` — the input set was emptied, so the now-stale profile (it described files the analysis no
 *   longer has) was removed and the UI falls back to "not profiled";
 * - `skipped_failed` — a `failed` profile row was left untouched: under managed parity a retry is
 *   deliberate ({@link forceReprofile}), so the auto-check never silently resurrects it;
 * - `no_inputs` — the analysis has no resolvable inputs (and none was ever profiled); skipped silently;
 * - `failed` — a step faulted (enumerate, ledger read, clear, staging, seed, or the trigger/retry
 *   itself); `reason` is a one-line, user-facing explanation the caller surfaces as a warning.
 */
export type ProfileParityOutcome =
    | { kind: "triggered"; restarted: boolean }
    | { kind: "already_profiled" }
    | { kind: "already_running" }
    | { kind: "cleared" }
    | { kind: "skipped_failed" }
    | { kind: "no_inputs" }
    | { kind: "failed"; reason: string };

/**
 * The effectful seams, injectable so the condition-ladder tests run offline (no Postgres, no Docker,
 * no model). Production callers pass nothing and get the real harness reads + enumerate + staging +
 * the shared `seedProfileLedger`. The `stage`/`seed`/`trigger` seams are the same functions `inflexa
 * profile` drives, so a happy-path test with the real `seed` asserts the exact params the command
 * builds; `retryClaim`/`run` mirror that command's failed-row recovery, driven by {@link forceReprofile}.
 */
export type ProfileParitySeams = {
    /** Reset an orphaned `running` ledger row (best-effort self-heal). */
    readonly reconcile: typeof reconcileOrphanedDataProfile;
    /** Cheap (stat/readdir) read of the current input fileId set — the drift check's left-hand side. */
    readonly enumerate: typeof enumerateInputFileIds;
    /** Read the ledger status (lifecycle state + the completed profile's `result.inputFileIds`). */
    readonly loadStatus: typeof loadDataProfileStatus;
    /** Null the ledger back to "not profiled" when the input set empties (guarded to skip a live run). */
    readonly clear: typeof clearDataProfile;
    /** Content-hash + link the inputs into the session tree — paid only once a (re-)trigger is decided. */
    readonly stage: typeof stageInputs;
    /** Seed the ledger row + build the trigger params (the construction shared with `inflexa profile`). */
    readonly seed: typeof seedProfileLedger;
    /** CAS-claim pending/completed rows and dispatch the workflow. */
    readonly trigger: typeof triggerDataProfile;
    /** Claim a `failed` row's `failed → running` transition (force-only recovery). */
    readonly retryClaim: typeof tryRetryDataProfile;
    /** Start the workflow for an already-claimed row (force-only recovery). */
    readonly run: typeof runDataProfile;
};

const realParitySeams: ProfileParitySeams = {
    reconcile: reconcileOrphanedDataProfile,
    enumerate: enumerateInputFileIds,
    loadStatus: loadDataProfileStatus,
    clear: clearDataProfile,
    stage: stageInputs,
    seed: seedProfileLedger,
    trigger: triggerDataProfile,
    retryClaim: tryRetryDataProfile,
    run: runDataProfile,
};

/**
 * Order-insensitive equality between the freshly enumerated input fileId set and the ids a completed
 * profile was taken against. Equal sizes plus every profiled id present in the current set means no
 * drift; either direction of difference (a file added or removed) is drift. Both sides come from the
 * same dedup'd id space (`enumerateInputFileIds` and staging share one walk), so `inputFileIds` carries
 * no duplicates and a size + membership check is exact — a null/absent `result` is handled by the caller.
 */
function inputSetMatches(current: ReadonlySet<string>, profiled: readonly string[]): boolean {
    if (current.size !== profiled.length) return false;
    for (const id of profiled) {
        if (!current.has(id)) return false;
    }
    return true;
}

/**
 * The stage → seed tail both entry points run once a (re-)trigger is decided: content-hash the inputs
 * into the session data dir, seed the ledger row, and build the trigger params. Reached only after the
 * cheap enumerate confirmed a non-empty input set, so it deliberately does NOT re-guard an empty
 * manifest — {@link enumerateInputFileIds} is the gate and staging shares its walk. Returns the built
 * params, or a one-line failure reason the caller wraps in a `failed` outcome. The trigger itself is
 * NOT here: parity and force map its result differently (parity never retries a `failed` row; force
 * mirrors the command's retry-claim), so each caller owns that step.
 */
async function stageAndSeed(runtime: HarnessRuntime, analysis: Analysis, seams: ProfileParitySeams): Promise<Result<DataProfileTriggerParams, string>> {
    const stageResult = await seams.stage(analysis.id, sessionTreeDataDir(analysis.id));
    if (stageResult.isErr()) return err(`staging inputs failed (${stageResult.error.type})`);

    const seedResult = await seams.seed(runtime.pool, analysis.id, stageResult.value);
    if (seedResult.isErr()) return err(`could not seed the analysis state (${seedResult.error.type})`);
    return ok(seedResult.value);
}

/**
 * Auto-trigger the data profile at managed parity for `analysis`, fire-and-forget (design D8). The
 * ladder, cheapest gate first:
 *
 *   0. Reconcile an orphaned `running` ledger row (best-effort) — a prior run that died between the CAS
 *      and its DBOS workflow insert leaves the row wedged at `running` with nothing to resume; boot has
 *      run DBOS recovery, so a still-`running` row with no workflow is genuinely orphaned. Reset it so
 *      the status read below re-triggers instead of reporting `already_running` forever.
 *   1. Enumerate the current input fileId set at stat/readdir cost (no hashing) — the drift check's
 *      left-hand side. An enumerate fault is `failed` (parity can't be judged).
 *   2. Read the ledger status — its lifecycle state plus the completed profile's `result.inputFileIds`
 *      (the set the profile was taken against). A ledger read fault is `failed`.
 *   3. Branch on the input set:
 *      - EMPTY — never profiled (`null`) → `no_inputs`; a live run → `already_running` (never clear a
 *        live run); otherwise the profile now describes files that are gone, so {@link clearDataProfile}
 *        nulls it → `cleared` (or `already_running` if the row raced into `running` — the guard's only
 *        skip; a clear fault is `failed`).
 *      - NON-EMPTY — a live run → `already_running`; a `failed` row → `skipped_failed` (managed parity
 *        never auto-retries — retry is deliberate, via {@link forceReprofile}); a `completed` row whose
 *        recorded set equals the current one → `already_profiled`; a drifted (or null-`result`)
 *        completed row, a `pending` row, or a never-profiled `null` → stage → seed → trigger.
 *   4. Stage (content hashing — paid only now), seed the ledger, trigger, and map the harness result to
 *      `triggered` / `already_running` / `failed`.
 *
 * Chat is never gated on the profile (Cortex parity), so this returns as soon as the trigger is
 * dispatched — it never waits for completion. NO terminal/TUI output: the caller maps the outcome.
 */
export async function ensureProfileAtParity(
    runtime: HarnessRuntime,
    analysis: Analysis,
    seams: ProfileParitySeams = realParitySeams,
): Promise<ProfileParityOutcome> {
    // Best-effort self-heal of a wedged `running` row (step 0 above); a reconcile hiccup must not abort
    // parity — the status read still runs and the trigger's CAS remains the final arbiter.
    (await seams.reconcile(runtime.pool, analysis.id)).match(
        () => {},
        (e) => getLogger("harness").warn({ analysisId: analysis.id, err: e }, "orphaned-profile reconcile failed"),
    );

    const enumerateResult = seams.enumerate(analysis.id);
    if (enumerateResult.isErr()) return { kind: "failed", reason: `could not enumerate inputs (${enumerateResult.error.type})` };
    const currentIds = enumerateResult.value;

    const statusResult = await seams.loadStatus(runtime.pool, analysis.id);
    if (statusResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${statusResult.error.type})` };
    const status = statusResult.value;

    if (currentIds.size === 0) {
        // An emptied input set: nothing to profile now. A never-profiled analysis is the ordinary
        // "add inputs" state; a live run must never be cleared (its completion write would resurrect
        // half-cleared state); any settled prior profile now describes files that are gone, so clear it.
        if (status === null) return { kind: "no_inputs" };
        if (status.status === "running") return { kind: "already_running" };
        const clearResult = await seams.clear(runtime.pool, analysis.id);
        if (clearResult.isErr()) return { kind: "failed", reason: `could not clear the stale profile (${clearResult.error.type})` };
        // `clearDataProfile` skips (`ok(false)`) ONLY on a live `running` row — and we returned above
        // for `running`, so a false here means the row flipped to `running` between our status read and
        // the clear (a workflow started concurrently). A live run must never be cleared, so treat that
        // race exactly as the running branch above.
        return clearResult.value ? { kind: "cleared" } : { kind: "already_running" };
    }

    // A non-empty input set. A live run is a skip; a `failed` row is a deliberate-retry-only skip; a
    // completed row is at parity only when its recorded set still matches — every other state (drift, a
    // null `result`, `pending`, or a never-profiled `null`) falls through to (re-)trigger.
    if (status?.status === "running") return { kind: "already_running" };
    if (status?.status === "failed") return { kind: "skipped_failed" };
    if (status?.status === "completed") {
        // A completed row with a null `result` never recorded which files it covered — a contract gap
        // re-profiling heals, so treat it as drift rather than trusting the row's staleness.
        const profiled = status.result?.inputFileIds ?? null;
        if (profiled !== null && inputSetMatches(currentIds, profiled)) return { kind: "already_profiled" };
    }

    const paramsResult = await stageAndSeed(runtime, analysis, seams);
    if (paramsResult.isErr()) return { kind: "failed", reason: paramsResult.error };

    const result = await seams.trigger(runtime.triggerDeps, paramsResult.value);
    switch (result) {
        case "started":
        case "restarted":
            return { kind: "triggered", restarted: result === "restarted" };
        case "already_running":
            return { kind: "already_running" };
        case "failed":
            // The parity path does NOT attempt the retry-claim + re-run (that is the deliberate force
            // action's job) — it reports `failed` so the UI surfaces it and the user can re-open or run
            // `inflexa profile`. A `failed` ledger row was already skipped above, so this is the rarer
            // "the trigger itself faulted" case.
            return { kind: "failed", reason: "the profile workflow could not be started" };
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled trigger result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * Force a re-profile of `analysis`, fire-and-forget — the deliberate action the TUI's command palette /
 * dialog drives (design D8). Unlike {@link ensureProfileAtParity}, force is the user's explicit will, so
 * the drift comparison and the `failed`-state gate do NOT apply: past a live-run check it ALWAYS stages →
 * seeds → triggers. The ladder: reconcile (best-effort) → enumerate (an empty set is `no_inputs`; the
 * TUI words this as a refusal for the manual action, the headless module stays silent) → ledger read (a
 * live run is `already_running`; a read fault is `failed`) → stage → seed → trigger. A trigger that
 * returns `failed` — the row was `failed`, which the trigger's pending/completed CAS never claims —
 * mirrors `inflexa profile`'s recovery (`runProfile` in profile.ts): claim the `failed → running`
 * transition via `retryClaim`, then `run` the workflow for the now-claimed row.
 */
export async function forceReprofile(runtime: HarnessRuntime, analysis: Analysis, seams: ProfileParitySeams = realParitySeams): Promise<ProfileParityOutcome> {
    (await seams.reconcile(runtime.pool, analysis.id)).match(
        () => {},
        (e) => getLogger("harness").warn({ analysisId: analysis.id, err: e }, "orphaned-profile reconcile failed"),
    );

    const enumerateResult = seams.enumerate(analysis.id);
    if (enumerateResult.isErr()) return { kind: "failed", reason: `could not enumerate inputs (${enumerateResult.error.type})` };
    if (enumerateResult.value.size === 0) return { kind: "no_inputs" };

    const statusResult = await seams.loadStatus(runtime.pool, analysis.id);
    if (statusResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${statusResult.error.type})` };
    // A live run owns the ledger; forcing over it would double-profile. Every other state is fair game —
    // force skips the drift and `failed`-state gates parity applies, because the user asked for it.
    if (statusResult.value?.status === "running") return { kind: "already_running" };

    const paramsResult = await stageAndSeed(runtime, analysis, seams);
    if (paramsResult.isErr()) return { kind: "failed", reason: paramsResult.error };
    const params = paramsResult.value;

    const result = await seams.trigger(runtime.triggerDeps, params);
    switch (result) {
        case "started":
        case "restarted":
            return { kind: "triggered", restarted: result === "restarted" };
        case "already_running":
            return { kind: "already_running" };
        case "failed": {
            // The trigger's CAS claims only pending/completed rows; a `failed` row needs the retry claim.
            // Mirror the command's managed retry route: claim `failed → running`, then start the workflow
            // for the now-claimed row. Force is deliberate, so unlike parity it DOES resurrect a failure.
            const claimResult = await seams.retryClaim(runtime.pool, analysis.id);
            if (claimResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${claimResult.error.type})` };
            // Lost the claim (`ok(false)`): the row is no longer `failed` — another attempt already moved
            // it on. The command dies with "could not start"; headless, we report a distinct `failed`
            // reason so the caller can word the refusal separately from a start fault.
            if (!claimResult.value) return { kind: "failed", reason: "could not claim the failed profile to retry" };
            // Claimed `failed → running`. `runDataProfile` resolves once the run is DISPATCHED (not
            // completed) and compensates the ledger on a rejected start (see its doc), so bridging its
            // promise and mapping ok/err is the headless twin of the command's fire-and-forget `.catch`.
            // A resurrected failure is a re-profile, hence `restarted: true`.
            return await ResultAsync.fromPromise(seams.run(runtime.triggerDeps, params), (cause) => cause).match(
                (): ProfileParityOutcome => ({ kind: "triggered", restarted: true }),
                (): ProfileParityOutcome => ({ kind: "failed", reason: "the profile workflow could not be started" }),
            );
        }
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled trigger result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
