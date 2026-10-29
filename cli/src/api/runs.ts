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
    | { reason: "references_missing"; missing: string[]; unavailable?: string }
    | { reason: "not_authorized" | "suspended" };

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
    /** The input files that the profile must cover, or `null` when the seed was not recorded. */
    seedInputFileIds: string[] | null;
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
};

/**
 * What one profile drive did. `kind` is the profile decision. `materialized` is true when the current input
 * set is on disk under the workspace at the end of the drive, whether or not this drive wrote it.
 */
export type ProfileOutcome =
    | { kind: "triggered"; restarted: boolean; materialized: true }
    | { kind: "already_profiled"; materialized: true }
    | { kind: "already_running"; materialized: boolean }
    | { kind: "cleared"; materialized: false }
    | { kind: "skipped_failed"; materialized: true }
    | { kind: "no_inputs"; materialized: false }
    | { kind: "failed"; reason: string; materialized: boolean };

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
