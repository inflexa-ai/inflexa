// The wire types of the runs and the data profile of an analysis (draft 2.4). Each harness type below is a
// type-only import: it is erased at compile time, thus a client that imports this file loads no harness code.
import type {
    ChatMessage,
    DataProfileLifecycleStatus,
    DataProfileResult,
    PlanGraphStep,
    PlanPart,
    RunSynthesisPart,
} from "@inflexa-ai/harness/contracts/index.js";
import type { CancelRunResult as HarnessCancelRunResult } from "@inflexa-ai/harness/execution/run-canceler.js";
import type { StepMethods } from "@inflexa-ai/harness/execution/step-methods.js";
import type {
    RunStatus as HarnessRunStatus,
    StepExecutionStatus as HarnessStepExecutionStatus,
    SynthesisStatus,
    TerminalRunStatus as HarnessTerminalRunStatus,
} from "@inflexa-ai/harness/state/schema.js";

import type { ListEnvelope } from "./common.ts";
import type { UsageTotals } from "./usage.ts";

/** The status of a run row. The harness enum, so a new status breaks each exhaustive switch over it. */
export type RunStatus = HarnessRunStatus;

/** The status of one step row of a run. The harness enum, for the same reason as {@link RunStatus}. */
export type StepExecutionStatus = HarnessStepExecutionStatus;

/** The status of a run that ended: every status but `running`. */
export type TerminalRunStatus = HarnessTerminalRunStatus;

/** The body of `POST {A}/run/:runId/seen`. A second mark of the same run gives the same body. */
export type RunSeenResponse = {
    seen: true;
};

/** The body of `POST {A}/run/:runId/cancel`: what the cancel did, and which ledgers converged. */
export type CancelRunResult = HarnessCancelRunResult;

/** A run of an analysis: the Cortex run item, plus the plan title and the usage. Timestamps are ISO 8601. */
export type RunSummary = {
    runId: string;
    /** The conversation thread whose turn launched the run, or `null` for a run with no thread. */
    threadId: string | null;
    /** The plan that the run executes, or `null` for a run with no plan. */
    planId: string | null;
    workflowName: string;
    /** The DBOS workflow id of the run. It is equal to `runId`. */
    workflowId: string;
    status: RunStatus;
    startedAt: string;
    completedAt: string | null;
    error: string | null;
    /** The human title of the plan of the run. Absent when the plan is gone, unreadable, or has no title. */
    planTitle?: string;
    /** What the calls of the run consumed. Absent when the ledger holds no call of the run, or its read failed. */
    usage?: UsageTotals;
    /** The count of the step outputs that the run registered. Absent when the count read failed. */
    artifactCount?: number;
    /** The count of the steps of the run that completed. Absent when the step count read failed. */
    doneSteps?: number;
    /** The count of the steps of the run that run now. Absent when the step count read failed. */
    runningSteps?: number;
    /**
     * The count of the steps in the ledger of the run, the synthesis step included. A step that waits counts here only.
     * Absent when the step count read failed.
     */
    totalSteps?: number;
};

/**
 * The body of `GET {A}/runs`: newest first. With `active=true`, only the runs that are not terminal. With
 * `q`, only the runs whose run id or plan title holds the text, with no regard to case. `q` narrows `active`
 * and `threadId`, and `total` counts the runs that it selects. With `threadId` and no `active=true`, `total`
 * is a lower bound: the harness has no count of the runs of one thread, thus `total` counts the selected runs
 * up to this page, plus one when a later page has a selected run.
 */
export type RunList = ListEnvelope<"runs", RunSummary>;

/** One step of a run, as `GET {A}/run/:runId` gives it. */
export type RunStepSummary = {
    stepId: string;
    /** The human name of the step, from the plan of the run. Absent when the plan has none for this step. */
    name?: string;
    agentId: string;
    status: StepExecutionStatus;
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number | null;
    error: string | null;
    /** The 1-based count of the attempts of the step. */
    attempts: number;
    /** The blocker that the agent declared, or `null` unless the status is `blocked`. */
    blockedReason: string | null;
    /** What the calls of this step consumed. Absent when the ledger holds no call of the step, or its read failed. */
    usage?: UsageTotals;
};

/** The graph of the plan of a run, as the stored plan fixes it: one entry for each plan step, started or not. */
export type RunPlan = {
    planId: string;
    steps: PlanGraphStep[];
};

/** The body of `GET {A}/run/:runId`: one run with its steps and the usage of each step. */
export type RunDetail = RunSummary & {
    /** The step rows of the run, in the order of the ledger. */
    steps: RunStepSummary[];
    /** The plan graph of the run, or `null` when the run has no plan, or the plan is gone or unreadable. */
    plan: RunPlan | null;
    /**
     * What the calls of the run that belong to no step consumed (the plan and the synthesis frames), or
     * `null` when each call has a step or the usage read failed. The run `usage` counts these calls, and no
     * step shows them.
     */
    unattributedUsage: UsageTotals | null;
};

/** The body of `POST {A}/plans/:planId/approve`. */
export type ApprovePlanBody = {
    /** The conversation thread on which the person approves the plan. */
    threadId: string;
    /**
     * The newest run of the plan that the client saw: the first id of the `runIds` of `GET {A}/plans/:planId`, or
     * `null` when that list was empty. The approval starts a run only when it is the newest run of the plan.
     */
    newestRunId: string | null;
};

/**
 * The 201 body of `POST {A}/plans/:planId/approve`. `started: false` means that a run of the plan was active, or
 * that the newest run of the plan was not the `newestRunId` of the body (a stale view). `runId` then names that
 * run, the approval recorded nothing, and `message` is `null`. `message` is also `null` when the record of an
 * approval that started the run could not be stored.
 */
export type PlanApprovalResult = {
    planId: string;
    runId: string;
    started: boolean;
    /** The record of the approval, in the shape of a message of `GET {T}/messages`, with no `createdAt`. */
    message: ChatMessage | null;
};

/** The `details` of a 409 `conflict` of `POST {A}/plans/:planId/approve`. The `reason` tells the cases apart. */
export type PlanApprovalConflict =
    | { reason: "superseded"; supersededBy: string }
    | { reason: "plan_invalid"; errors: string[] }
    | { reason: "packages_missing"; missing: string[]; collisions: string[]; unavailable?: string }
    | { reason: "agent_unavailable"; steps: { stepId: string; agentId: string }[] }
    | { reason: "not_authorized"; kind: "failed"; transient: boolean }
    | { reason: "not_authorized"; kind: "credential" }
    | { reason: "suspended" };

/** One plan of `GET {A}/plans`: its identity, its title, and its references. Timestamps are ISO 8601. */
export type PlanSummary = {
    /** The id of the plan. */
    planId: string;
    /** When the plan was made. */
    createdAt: string;
    /** The title of the plan with the spaces at its start and end removed, or `null` when the plan has no title. */
    title: string | null;
    /** The plan that this plan revised, or `null` for a first plan. */
    parentPlanId: string | null;
    /** The newest plan of the analysis that revised this plan, or `null`. */
    supersededBy: string | null;
    /** The id of the newest run of the plan, or `null` when the plan has no run. */
    newestRunId: string | null;
};

/** The body of `GET {A}/plans`: one page of the plans of an analysis, newest first. */
export type PlanList = ListEnvelope<"plans", PlanSummary>;

/** The body of `GET {A}/plans/:planId`: a plan with its lineage and the ids of its runs. */
export type PlanView = {
    /** The `data-plan` part of the stored plan, or `null` when the plan document gives no part. */
    plan: PlanPart | null;
    /** The plan that this plan revised, or `null` for a first plan. */
    parentPlanId: string | null;
    /** The newest plan of the analysis that revised this plan, or `null`. */
    supersededBy: string | null;
    /** The ids of the runs of the plan, newest first, at most 100. */
    runIds: string[];
    /** True when the plan has runs beyond `runIds`. */
    hasMoreRuns: boolean;
};

/** The ledger row of the data profile of an analysis, when one exists. Timestamps are ISO 8601. */
export type DataProfileState = {
    status: DataProfileLifecycleStatus;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
    result: DataProfileResult | null;
    /**
     * The DBOS workflow id of the profile attempt, which `GET {A}/run/:runId/stream` accepts. `null` until the
     * workflow body records it.
     */
    workflowId: string | null;
    /** The count of the input files that the profile must cover, or `null` when the seed was not recorded. */
    seedInputCount: number | null;
};

/** The progress of a staging pass: the files placed under the workspace, of the total. */
export type StagingProgress = {
    done: number;
    total: number;
};

/**
 * The body of `GET {A}/data-profile`. `status: null` is an analysis that was never profiled, or whose profile
 * was cleared. Otherwise the ledger row, and what the calls of the profile consumed.
 */
export type DataProfileView = ({ status: null } | (DataProfileState & { usage?: UsageTotals })) & {
    /**
     * Present while the server holds profile work that the row does not show yet: an input change that waits
     * for its re-profile, or a drive that is queued or runs. A client reads the row again until it is absent.
     */
    workPending?: true;
    /** Present while a drive stages the inputs into the workspace. A drive that stages also sets `workPending`. */
    staging?: StagingProgress;
};

/**
 * What one profile drive did (a parity, input-change, or force check), as a discriminated union the caller maps to UI feedback:
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
export type ProfileOutcome = (
    | { kind: "triggered"; restarted: boolean; materialized: true }
    | { kind: "already_profiled"; materialized: true }
    | { kind: "already_running"; materialized: boolean }
    | { kind: "cleared"; materialized: false }
    | { kind: "skipped_failed"; materialized: true }
    | { kind: "no_inputs"; materialized: false }
    | { kind: "failed"; reason: string; materialized: boolean }
) & {
    /** One line for each source that the drive could not read or reach. Staging kept its earlier staged files, and the profile stays. */
    warnings?: readonly string[];
};

/**
 * The body of `GET {A}/chat-context`: the agent of the conversation, and the profile state after the parity
 * drive that the request ran. `parity` is the outcome of that drive.
 */
export type ChatContext = {
    analysisId: string;
    agentId: string;
    dataProfile: DataProfileView;
    parity: ProfileOutcome;
};

/** The body of `POST {A}/data-profile/rerun` (202): the outcome of the deliberate re-profile. */
export type ProfileRerunResult = {
    outcome: ProfileOutcome;
};

/** The state of the content of the package store root, from the filesystem. */
export type StoreContentState = "missing" | "local" | "incomplete" | "installed" | "invalid_receipt";

/** The state of the configured sandbox image in the container engine, with no pull. */
export type SandboxImageReadiness =
    /** The engine holds the image. */
    | { state: "present"; image: string }
    /** The engine does not hold the published image. `inflexa sandbox pull` downloads it. */
    | { state: "absent"; image: string }
    /** The engine does not hold a custom image, and no registry can supply it. */
    | { state: "custom"; image: string }
    /** The engine could not be reached, or it failed. */
    | { state: "engine_error"; image: string; message: string };

/** The body of `GET {A}/sandbox-readiness`: the verdict of the machine for a sandbox of this analysis. */
export type SandboxReadiness = {
    image: SandboxImageReadiness;
    /** The package store: `installed` and `local` can serve a sandbox, each other state cannot. */
    store: StoreContentState;
    farm: {
        /** True when the package farm of the analysis exists. */
        present: boolean;
        /** True when the catalog farm exists, from which a missing farm of an analysis can be composed. */
        catalogPresent: boolean;
        /**
         * Why the last composition of the farm of this analysis failed, or `null`. The read leaves the
         * record, thus the next profile refusal can name the cause. The gate clears it when it reads the
         * machine.
         */
        failure: string | null;
    };
    /** The count of the inputs of the analysis. An analysis with no inputs profiles nothing, thus it needs no image and no store. */
    inputCount: number;
};

/** The outcome of `POST {A}/farm/heal` (202). */
export type FarmHealOutcome =
    /** The farm of the analysis exists. Nothing was composed. */
    | { kind: "already_present" }
    /** The catalog farm does not exist, thus the farm cannot be composed. The catalog transfer supplies it. */
    | { kind: "no_catalog" }
    /** The farm was composed from the catalog closure. */
    | { kind: "composed"; packages: number }
    /** The composition failed. `reason` is one line for a person. */
    | { kind: "failed"; reason: string };

/** The body of `POST {A}/farm/heal`. */
export type FarmHealResult = {
    outcome: FarmHealOutcome;
};

/**
 * The body of `GET {A}/run/:runId/synthesis`. `status` and `reason` are the synthesis outcome of the run row.
 * `synthesis` is the flat part that the run stream carries. It is `null` unless `status` is `produced`, and
 * also when a produced record is gone, unreadable, over 1 MiB, or invalid.
 */
export type RunSynthesisView = {
    status: SynthesisStatus | null;
    reason: string | null;
    synthesis: RunSynthesisPart | null;
};

/**
 * The body of `GET {A}/run/:runId/methods`: the methods of each step of the run that has methods, in plan order. The
 * host builds them from the grounding of the plan step and the templates that the step rendered, from any template
 * source. A step with no grounding and no rendered template is absent.
 */
export type RunMethodsView = {
    steps: { stepId: string; methods: StepMethods }[];
};
