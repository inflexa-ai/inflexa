import { err, ok, ResultAsync, type Result } from "neverthrow";
import {
    clearDataProfile,
    loadDataProfileStatus,
    makeLocalAuth,
    reconcileOrphanedDataProfile,
    runDataProfile,
    triggerDataProfile,
    tryRetryDataProfile,
    upsertAnalysis,
    type DataProfileStatus,
    type DataProfileTriggerParams,
    type DbError,
    type Pool,
} from "@inflexa-ai/harness";

import { getLogger } from "../../lib/log.ts";
import type { Analysis } from "../../types/analysis.ts";
import { workspaceDataDir } from "../analysis/output.ts";
import { enumerateInputSignatures, inputSignature, inputSignatureDigest, isInputSetMaterialized, stageInputs, type StagedInput } from "../staging/staging.ts";
import { noteDataProfileState } from "./agent_switch.ts";
import type { HarnessRuntime } from "./runtime.ts";

// The headless data-profile parity checks. Two entry points, both writing NO terminal/TUI
// output — the reactive hook (`tui/hooks/profile_parity.ts`) maps their discriminated outcome to a
// notice: `ensureProfileAtParity` is the managed auto-check the TUI fires when a chat opens on `ready`
// (and after an analysis swap); `forceReprofile` is the deliberate re-profile the palette/dialog action
// drives. Both own the DECISION — enumerate → (drift/status branch) → materialize → seed → trigger — and
// share the materialize → seed core with `inflexa profile` (`seedProfileLedger` below), so the
// ledger contract stays single-sourced. The cheap `enumerateInputSignatures` runs FIRST so the drift
// check costs only stat/readdir.
//
// Materialization is NOT conditioned on the profile lifecycle. It used to sit at the bottom of the
// ladder, so every early return above it (a `failed` row above all) silently withheld the user's files
// from the workspace tree while the database happily recorded them. A live `running` profile is the one
// state that still suppresses it, because staging reconcile-deletes a tree that run's sandbox is reading.

/**
 * Seed the harness ledger row and build the {@link DataProfileTriggerParams} for `staged` — the ONE
 * construction its two callers share: the parity auto-trigger below, and the dev `inflexa profile`
 * command. The field mapping IS the ledger contract, so it lives in exactly one place, and drift
 * between the two callers would corrupt the ledger.
 *
 * That one place is here rather than beside the command, because the dependency runs one way: a
 * product file must never import the dev directory, so of the pair it is the product caller that
 * must hold the shared half.
 *
 * `context` stays null — neither caller has goal text at profile time, and a fabricated one would
 * pollute the agent prompt. `inputFileIds` is the staged manifest's file ids, the auth is the local
 * OSS value, and the manifest rides into the trigger params verbatim.
 */
export function seedProfileLedger(pool: Pool, analysisId: string, staged: readonly StagedInput[]): ResultAsync<DataProfileTriggerParams, DbError> {
    return upsertAnalysis(
        pool,
        analysisId,
        null,
        staged.map((f) => f.fileId),
    ).map(() => ({ auth: makeLocalAuth(), analysisId, stagedInputs: staged }));
}

/**
 * The outcome of a parity (or force) check, as a discriminated union the caller maps to UI feedback:
 * - `triggered` — a profile workflow was started; `restarted` is true iff it superseded a prior profile
 *   (a re-profile / retry), so the UI can word "Re-profiling…" vs a first-time "Profiling…";
 * - `already_profiled` — a completed profile already covers exactly the current input set, so nothing ran;
 * - `already_running` — a profile is already in flight (the ledger showed `running`, the trigger's CAS
 *   lost to another attempt, or a clear/retry raced a run that had just started), so nothing new ran;
 * - `cleared` — the input set was emptied, so the now-stale profile (it described files the analysis no
 *   longer has) was removed and the UI falls back to "not profiled";
 * - `skipped_failed` — a `failed` profile row was left untouched because the input set that failed is
 *   still the one on disk: under managed parity, retrying a failure against the same inputs is
 *   deliberate ({@link forceReprofile}), so the auto-check never silently resurrects it;
 * - `no_inputs` — the analysis has no resolvable inputs (and none was ever profiled); skipped silently;
 * - `failed` — a step faulted (enumerate, ledger read, clear, staging, seed, or the trigger/retry
 *   itself); `reason` is a one-line, user-facing explanation the caller surfaces as a warning.
 *
 * `kind` describes the PROFILE decision only. The orthogonal `materialized` flag reports the materialization
 * STATE the check finished in — "the current input set is on disk" — NOT whether this drive did the
 * writing. So `already_profiled` (a completed profile at parity) and `skipped_failed` (a `failed` row the
 * predicate found materialized) both carry `materialized: true` having written nothing, which is the point: a
 * caller can tell "the files are on disk but profiling did not run" from "nothing happened".
 *
 * `materialized` is FIXED for five of the seven kinds, so the type pins each to a literal rather than `boolean`
 * — the union states which states are bivalent instead of a comment claiming it. A path that reached a
 * (re-)trigger always materialized first (`triggered` → `true`); the two write-nothing-but-on-disk cases
 * above are `true`; `cleared`/`no_inputs` describe an empty set with nothing to stage (`false`). Only two
 * kinds genuinely take either value, which is where the flag earns its keep:
 *   - `already_running` — `false` when the live-run gate suppressed staging up front (the sandbox is
 *     reading the tree staging would reconcile-delete), but `true` when THIS drive staged and then lost
 *     the trigger's CAS to a run that claimed the row concurrently;
 *   - `failed` — `false` for a fault before or during materialization (enumerate, ledger read, dataDir
 *     resolve, the staging write itself), `true` for a fault AFTER the files landed (seed, trigger, retry).
 * Kinds for each staging×profile combination were rejected — they would multiply the union and every
 * consumer's switch to express two facts that compose.
 *
 * No consumer branches on `materialized` today; the drivers (`tui/hooks/profile_parity.ts`) switch on `kind`
 * alone. It is reported now because the check is the only place that knows it, so that a later
 * caller — a "files staged, profiling deferred" affordance — reads a recorded fact instead of
 * re-deriving one. Populated and tested on every variant so that consumer inherits a correct value, not
 * a retrofit.
 */
export type ProfileParityOutcome =
    | { kind: "triggered"; restarted: boolean; materialized: true }
    | { kind: "already_profiled"; materialized: true }
    | { kind: "already_running"; materialized: boolean }
    | { kind: "cleared"; materialized: false }
    | { kind: "skipped_failed"; materialized: true }
    | { kind: "no_inputs"; materialized: false }
    | { kind: "failed"; reason: string; materialized: boolean };

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
    /** Cheap (stat/readdir) read of the current input signature set — the drift check's left-hand side. */
    readonly enumerate: typeof enumerateInputSignatures;
    /** Read the ledger status (lifecycle state + the completed profile's input comparand). */
    readonly loadStatus: typeof loadDataProfileStatus;
    /** Null the ledger back to "not profiled" when the input set empties (guarded to skip a live run). */
    readonly clear: typeof clearDataProfile;
    /** Resolve the analysis workspace's `data/` root — the staging target (errs on an unusable workspace). */
    readonly dataDir: typeof workspaceDataDir;
    /** Is the current input set already on disk under the workspace tree? Stat/readdir cost, no hashing. */
    readonly materialized: typeof isInputSetMaterialized;
    /** Content-hash + link the inputs into the workspace tree — the only step that writes the tree. */
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
    enumerate: enumerateInputSignatures,
    loadStatus: loadDataProfileStatus,
    clear: clearDataProfile,
    dataDir: workspaceDataDir,
    materialized: isInputSetMaterialized,
    stage: stageInputs,
    seed: seedProfileLedger,
    trigger: triggerDataProfile,
    retryClaim: tryRetryDataProfile,
    run: runDataProfile,
};

/**
 * Order-insensitive equality between the freshly enumerated input signature set and the signatures a
 * completed profile was taken against. Equal sizes plus every profiled signature present in the current
 * set means no drift; a difference in either direction — a file added, removed, or REWRITTEN IN PLACE —
 * is drift. Both sides come from the same dedup'd space (`enumerateInputSignatures` and staging share
 * one walk), so the profiled list carries no duplicates and a size + membership check is exact.
 */
function inputSetMatches(current: ReadonlySet<string>, profiled: readonly string[]): boolean {
    if (current.size !== profiled.length) return false;
    for (const sig of profiled) {
        if (!current.has(sig)) return false;
    }
    return true;
}

/**
 * Whether a completed ledger row was taken against the input set enumerated just now.
 *
 * Which comparand the row carries depends on when it was written, and both eras answer the same
 * question:
 *
 * - `inputSignature` (current) — `{ count, digest }` over the profiled set's identities, sizes, and
 *   mtimes. Compared by digesting the current enumeration through the harness's OWN function, so the
 *   two sides cannot drift apart in how they define "the same set".
 * - `inputFiles` (legacy) — the per-file triples the signature replaced, compared member-wise.
 *
 * A row carrying neither cannot prove it covered the current bytes — `inputFileIds` answers WHICH
 * files, never WHETHER they changed — so it reads as drift. Re-profiling repairs the contract gap and
 * costs one run, the same self-heal the null-`result` case has always had.
 */
function isProfiledAtParity(status: DataProfileStatus | null, current: ReadonlySet<string>): boolean {
    const result = status?.result;
    if (!result) return false;
    if (result.inputSignature) {
        const now = inputSignatureDigest(current);
        return now.count === result.inputSignature.count && now.digest === result.inputSignature.digest;
    }
    if (result.inputFiles) {
        return inputSetMatches(
            current,
            result.inputFiles.map((f) => inputSignature(f.fileId, f.size, f.mtimeMs)),
        );
    }
    return false;
}

/**
 * The staging target — the analysis workspace's `data/` root — with the resolution fault already phrased
 * as the one-line reason an outcome carries. Resolved once per drive and shared by the
 * already-materialized check and {@link materializeInputs}, so the predicate and the write it gates can
 * never be asked about different trees.
 */
function resolveDataDir(analysis: Analysis, seams: ProfileParitySeams): Result<string, string> {
    return seams.dataDir(analysis).mapErr((e) => (e.type === "workspace_unavailable" ? e.message : `workspace resolution failed (${e.type})`));
}

/**
 * Materialize the analysis's current input set into `dataDir` — the ONE step that writes the workspace
 * tree, and the half of the old stage → seed pair that is now decided on its own. Reached only after the
 * cheap enumerate confirmed a non-empty input set, so it deliberately does NOT re-guard an empty
 * manifest — {@link enumerateInputSignatures} is the gate and staging shares its walk. Returns the
 * manifest (the seed's and the trigger's input), or a one-line failure reason.
 */
async function materializeInputs(analysis: Analysis, dataDir: string, seams: ProfileParitySeams): Promise<Result<StagedInput[], string>> {
    // TODO(robustness): exclude restaging against a live `executeAnalysis` run on this analysis. `stage`
    // (`stageInputs`) rm/relinks the shared `data/inputs` tree and reconciles it against its own manifest
    // (`reconcileStagedTree`'s `rmSync`), so an input edit (parity edge 2) that restages while a sandbox
    // step is reading that tree can delete files out from under the running container — a mid-run I/O
    // fault. The missing gate is an active-run check here (skip or defer staging while a run is in
    // flight); it wants the run-liveness read the ledger already exposes and is left out now to keep this
    // change scoped to the parity/staging convergence fix.
    const stageResult = await seams.stage(analysis.id, dataDir);
    return stageResult.mapErr((e) => `staging inputs failed (${e.type})`);
}

/**
 * Seed the ledger row from a materialized manifest and build the trigger params — the construction
 * shared with `inflexa profile`. Split from materialization because seeding is the first step that
 * COMMITS to a (re-)trigger, and materialization no longer implies one: a `failed` row whose input set
 * is unchanged stops short of here. The trigger itself is not here either — parity and force reach the
 * ledger's `failed` state by different routes, so each caller owns that step.
 */
async function seedFromManifest(
    runtime: HarnessRuntime,
    analysis: Analysis,
    staged: StagedInput[],
    seams: ProfileParitySeams,
): Promise<Result<DataProfileTriggerParams, string>> {
    const seedResult = await seams.seed(runtime.pool, analysis.id, staged);
    if (seedResult.isErr()) return err(`could not seed the analysis state (${seedResult.error.type})`);

    // Feed the agent-switch gauge's data-profile START half. This is the ONE
    // shared choke both TUI entry points (`ensureProfileAtParity`, `forceReprofile`) reach exactly when a
    // (re-)trigger has been decided — the seed just landed and a trigger is imminent — so a single note
    // here marks the sandbox agent busy synchronously, closing the fail-open window between dispatch and
    // the sidebar poll catching up (the gauge's SETTLE half). The `inflexa profile` CLI path (profile.ts)
    // is deliberately NOT instrumented: it runs in a separate, blocking process with no live palette to
    // request an agent switch, so its gauge is moot. A trigger that then faults leaves the token busy until
    // the SETTLE observer clears it on the ledger row's terminal state (fail-closed if that never comes:
    // the pending selection waits; config is already the durable truth).
    noteDataProfileState(analysis.id, true);
    return ok(seedResult.value);
}

/**
 * Resurrect a `failed` ledger row: claim its `failed → running` transition, then start the workflow for
 * the now-claimed row — the recovery `inflexa profile` performs (`runProfile` in profile.ts). The
 * trigger's CAS claims only pending/completed rows, so this is the only route back out of `failed`.
 * Shared by both entry points, which arrive from opposite directions: parity when a `failed` row's input
 * set drifted (the failure is not evidence about the set now on disk), force whenever its trigger reports
 * the row was `failed`. Both have already materialized, hence `materialized: true` throughout.
 */
async function retryFailedRow(
    runtime: HarnessRuntime,
    analysis: Analysis,
    params: DataProfileTriggerParams,
    seams: ProfileParitySeams,
): Promise<ProfileParityOutcome> {
    const claimResult = await seams.retryClaim(runtime.pool, analysis.id);
    // `tryRetryDataProfile` is a `failed → running` CAS UPDATE, not a read; a `DbError`
    // here is a CAS-failure query fault, not a ledger-read miss (the caller already read
    // the ledger). Phrase the refusal as a claim failure, not a read failure, so
    // the toast wording stays accurate under this rare race.
    if (claimResult.isErr()) return { kind: "failed", reason: `could not claim the failed profile to retry (${claimResult.error.type})`, materialized: true };
    // Lost the claim (`ok(false)`): the row is no longer `failed` — another attempt already moved
    // it on. The command dies with "could not start"; headless, we report a distinct `failed`
    // reason so the caller can word the refusal separately from a start fault.
    if (!claimResult.value) return { kind: "failed", reason: "could not claim the failed profile to retry", materialized: true };
    // Claimed `failed → running`. `runDataProfile` resolves once the run is DISPATCHED (not
    // completed) and compensates the ledger on a rejected start (see its doc), so bridging its
    // promise and mapping ok/err is the headless twin of the command's fire-and-forget `.catch`.
    // A resurrected failure is a re-profile, hence `restarted: true`.
    return await ResultAsync.fromPromise(seams.run(runtime.triggerDeps, params), (cause) => cause).match(
        (): ProfileParityOutcome => ({ kind: "triggered", restarted: true, materialized: true }),
        (): ProfileParityOutcome => ({ kind: "failed", reason: "the profile workflow could not be started", materialized: true }),
    );
}

/**
 * Auto-trigger the data profile at managed parity for `analysis`, fire-and-forget. The
 * ladder, cheapest gate first:
 *
 *   0. Reconcile an orphaned `running` ledger row (best-effort) — a prior run that died between the CAS
 *      and its DBOS workflow insert leaves the row wedged at `running` with nothing to resume; boot has
 *      run DBOS recovery, so a still-`running` row with no workflow is genuinely orphaned. Reset it so
 *      the status read below re-triggers instead of reporting `already_running` forever.
 *   1. Enumerate the current input signature set at stat/readdir cost (no hashing) — the drift check's
 *      left-hand side. An enumerate fault is `failed` (parity can't be judged).
 *   2. Read the ledger status — its lifecycle state plus the completed profile's `result.inputFiles`
 *      (the set the profile was taken against). A ledger read fault is `failed`.
 *   3. Branch on the input set:
 *      - EMPTY — never profiled (`null`) → `no_inputs`; a live run → `already_running` (never clear a
 *        live run); otherwise the profile now describes files that are gone, so {@link clearDataProfile}
 *        nulls it → `cleared` (or `already_running` if the row raced into `running` — the guard's only
 *        skip; a clear fault is `failed`).
 *      - NON-EMPTY — a live run → `already_running`, the ONLY state that also suppresses
 *        materialization; a `completed` row whose recorded set equals the current one →
 *        `already_profiled` (its set is materialized by construction, so there is nothing to write).
 *   4. Materialize the current input set (content hashing) — for a `failed` row only when the staged
 *      tree says it is not already on disk, since every other state below (re-)profiles and seeding
 *      needs the manifest anyway. A staging fault is `failed` and stops here: no seed, no trigger.
 *   5. Decide the profile: a `failed` row that was already materialized → `skipped_failed` (that is the
 *      set that failed; retrying it is deliberate, via {@link forceReprofile}); a `failed` row whose set
 *      drifted → the retry claim + run, exactly as force does; everything else — a drifted (or
 *      null-`result`) completed row, a `pending` row, a never-profiled `null` → seed → trigger, mapping
 *      the harness result to `triggered` / `already_running` / `failed`.
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
    if (enumerateResult.isErr()) return { kind: "failed", reason: `could not enumerate inputs (${enumerateResult.error.type})`, materialized: false };
    const currentSignatures = enumerateResult.value;

    const statusResult = await seams.loadStatus(runtime.pool, analysis.id);
    if (statusResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${statusResult.error.type})`, materialized: false };
    const status = statusResult.value;

    if (currentSignatures.size === 0) {
        // An emptied input set: nothing to profile now, and nothing to materialize either. A
        // never-profiled analysis is the ordinary "add inputs" state; a live run must never be cleared
        // (its completion write would resurrect half-cleared state); any settled prior profile now
        // describes files that are gone, so clear it.
        if (status === null) return { kind: "no_inputs", materialized: false };
        if (status.status === "running") return { kind: "already_running", materialized: false };
        const clearResult = await seams.clear(runtime.pool, analysis.id);
        if (clearResult.isErr()) return { kind: "failed", reason: `could not clear the stale profile (${clearResult.error.type})`, materialized: false };
        // `clearDataProfile` skips (`ok(false)`) ONLY on a live `running` row — and we returned above
        // for `running`, so a false here means the row flipped to `running` between our status read and
        // the clear (a workflow started concurrently). A live run must never be cleared, so treat that
        // race exactly as the running branch above.
        return clearResult.value ? { kind: "cleared", materialized: false } : { kind: "already_running", materialized: false };
    }

    // A non-empty input set. The two states that skip materialization as well as profiling, and nothing
    // else: no other ledger state may withhold the user's files from the workspace tree.
    if (status?.status === "running") {
        // Staging rm/relinks the shared `data/inputs` tree and then deletes every file absent from its
        // own manifest, while THIS run's sandbox is reading that tree — the hazard `materializeInputs`
        // carries as a TODO(robustness) for runs this ladder cannot observe, made concrete by a run it
        // can. The work is deferred, not dropped: the completion edge (`tui/hooks/profile_parity.ts`)
        // re-runs the check when the run reaches either terminal state.
        return { kind: "already_running", materialized: false };
    }
    if (status?.status === "completed") {
        // A completed profile at parity implies its set is materialized — it is the set that profile was
        // staged for, unchanged since — so this skips the predicate too and keeps the steady-state chat
        // open (nothing edited) on the stat/readdir path it has always been on. `materialized` reports that
        // STATE, not whether this drive performed it: the files are on disk, so it is true even though
        // nothing was written here. Inferred rather than checked, which is why the deliberate
        // {@link forceReprofile} / `inflexa profile` stays the repair path for a hand-emptied tree.
        if (isProfiledAtParity(status, currentSignatures)) return { kind: "already_profiled", materialized: true };
    }

    const dataDirResult = resolveDataDir(analysis, seams);
    if (dataDirResult.isErr()) return { kind: "failed", reason: dataDirResult.error, materialized: false };
    const dataDir = dataDirResult.value;

    // A `failed` row is the one state where materialization is conditional rather than implied: every
    // other state below (re-)profiles, and seeding needs the manifest's content hashes, which only
    // staging produces — so consulting the predicate there would cost a walk and change nothing.
    //
    // Here it doubles as the drift signal. The staged tree is the set the failed attempt ran against, so
    // a set still materialized IS the set that failed: re-running it unasked is the loop managed parity
    // refuses, and the deliberate re-profile owns that decision. A set that is NOT materialized is a set
    // the failure says nothing about — either it changed under a wedged analysis or it never landed —
    // and it gets both the files and a fresh run.
    if (status?.status === "failed") {
        const materializedResult = seams.materialized(analysis.id, dataDir);
        if (materializedResult.isErr()) {
            return { kind: "failed", reason: `could not check the staged inputs (${materializedResult.error.type})`, materialized: false };
        }
        // `materialized` reports the materialization STATE, not whether this drive performed it: the predicate
        // just confirmed the files are on disk, which is exactly the fact a caller needs to tell "the
        // inputs are materialized but profiling did not run" from "nothing happened".
        if (materializedResult.value) return { kind: "skipped_failed", materialized: true };
    }

    const stagedResult = await materializeInputs(analysis, dataDir, seams);
    if (stagedResult.isErr()) return { kind: "failed", reason: stagedResult.error, materialized: false };

    const paramsResult = await seedFromManifest(runtime, analysis, stagedResult.value, seams);
    if (paramsResult.isErr()) return { kind: "failed", reason: paramsResult.error, materialized: true };
    const params = paramsResult.value;

    // The trigger's CAS claims only pending/completed rows, so dispatching it against a row we just read
    // as `failed` would report a start failure for a row that simply needs the retry claim. Route it the
    // way force does instead.
    if (status?.status === "failed") return await retryFailedRow(runtime, analysis, params, seams);

    const result = await seams.trigger(runtime.triggerDeps, params);
    switch (result) {
        case "started":
        case "restarted":
            return { kind: "triggered", restarted: result === "restarted", materialized: true };
        case "already_running":
            return { kind: "already_running", materialized: true };
        case "failed":
            // A `failed` ledger row took the retry-claim route above, so reaching here means the trigger
            // itself faulted — report it so the UI surfaces it and the user can re-open or run
            // `inflexa profile`.
            return { kind: "failed", reason: "the profile workflow could not be started", materialized: true };
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled trigger result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}

/**
 * Force a re-profile of `analysis`, fire-and-forget — the deliberate action the TUI's command palette /
 * dialog drives. Unlike {@link ensureProfileAtParity}, force is the user's explicit will, so the drift
 * comparison, the `failed`-state gate, and the already-materialized predicate do NOT apply: past a
 * live-run check it ALWAYS materializes → seeds → triggers. Leaving materialization unconditional here
 * is deliberate — it keeps force (and `inflexa profile`) the repair path for a tree the predicate
 * misjudges, and keeps the predicate on the one call path that needed it. The ladder: reconcile
 * (best-effort) → enumerate (an empty set is `no_inputs`; the TUI words this as a refusal for the manual
 * action, the headless module stays silent) → ledger read (a live run is `already_running`; a read fault
 * is `failed`) → materialize → seed → trigger. A trigger that returns `failed` — the row was `failed`,
 * which the trigger's pending/completed CAS never claims — takes {@link retryFailedRow}, the same
 * recovery parity reaches when a failed row's input set drifted.
 */
export async function forceReprofile(runtime: HarnessRuntime, analysis: Analysis, seams: ProfileParitySeams = realParitySeams): Promise<ProfileParityOutcome> {
    (await seams.reconcile(runtime.pool, analysis.id)).match(
        () => {},
        (e) => getLogger("harness").warn({ analysisId: analysis.id, err: e }, "orphaned-profile reconcile failed"),
    );

    const enumerateResult = seams.enumerate(analysis.id);
    if (enumerateResult.isErr()) return { kind: "failed", reason: `could not enumerate inputs (${enumerateResult.error.type})`, materialized: false };
    if (enumerateResult.value.size === 0) return { kind: "no_inputs", materialized: false };

    const statusResult = await seams.loadStatus(runtime.pool, analysis.id);
    if (statusResult.isErr()) return { kind: "failed", reason: `could not read the profile ledger (${statusResult.error.type})`, materialized: false };
    // A live run owns the ledger AND is reading the staged tree; forcing over it would double-profile and
    // reconcile-delete under the sandbox. Every other state is fair game — force skips the drift, the
    // `failed`-state, and the already-materialized gates parity applies, because the user asked for it.
    if (statusResult.value?.status === "running") return { kind: "already_running", materialized: false };

    const dataDirResult = resolveDataDir(analysis, seams);
    if (dataDirResult.isErr()) return { kind: "failed", reason: dataDirResult.error, materialized: false };

    const stagedResult = await materializeInputs(analysis, dataDirResult.value, seams);
    if (stagedResult.isErr()) return { kind: "failed", reason: stagedResult.error, materialized: false };

    const paramsResult = await seedFromManifest(runtime, analysis, stagedResult.value, seams);
    if (paramsResult.isErr()) return { kind: "failed", reason: paramsResult.error, materialized: true };
    const params = paramsResult.value;

    const result = await seams.trigger(runtime.triggerDeps, params);
    switch (result) {
        case "started":
        case "restarted":
            return { kind: "triggered", restarted: result === "restarted", materialized: true };
        case "already_running":
            return { kind: "already_running", materialized: true };
        case "failed":
            // The trigger's CAS claims only pending/completed rows; a `failed` row needs the retry claim.
            // Force is deliberate, so unlike parity it resurrects a failure whose input set is unchanged.
            return await retryFailedRow(runtime, analysis, params, seams);
        default: {
            const _exhaustive: never = result;
            throw new Error(`unhandled trigger result: ${JSON.stringify(_exhaustive)}`);
        }
    }
}
