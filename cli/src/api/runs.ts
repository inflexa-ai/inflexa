// The wire types of the runs and the data profile of an analysis (draft 2.4). Each harness type below is a
// type-only import: it is erased at compile time, thus a client that imports this file loads no harness code.
import type { DataProfileLifecycleStatus, DataProfileResult } from "@inflexa-ai/harness/contracts/index.js";
import type { CancelRunResult as HarnessCancelRunResult } from "@inflexa-ai/harness/execution/run-canceler.js";
import type { RunStatus as HarnessRunStatus, StepExecutionStatus as HarnessStepExecutionStatus } from "@inflexa-ai/harness/state/schema.js";

import type { ListEnvelope } from "./common.ts";
import type { UsageTotals } from "./usage.ts";

/** The status of a run row. The harness enum, so a new status breaks each exhaustive switch over it. */
export type RunStatus = HarnessRunStatus;

/** The status of one step row of a run. The harness enum, for the same reason as {@link RunStatus}. */
export type StepExecutionStatus = HarnessStepExecutionStatus;

/** The body of `POST {A}/run/:runId/cancel`: what the cancel did, and which ledgers converged. */
export type CancelRunResult = HarnessCancelRunResult;

/** A run of an analysis: the Cortex run item, plus the plan title and the usage. Timestamps are ISO 8601. */
export type RunSummary = {
    runId: string;
    /** The conversation thread whose turn launched the run, or `null` for a run with no thread. */
    threadId: string | null;
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
};

/**
 * The body of `GET {A}/runs`: newest first. With `active=true`, only the runs that are not terminal. With
 * `threadId`, `total` is a lower bound: the harness has no count of the runs of one thread, thus `total`
 * counts the runs up to this page, plus one when a later page has runs.
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

/** The body of `GET {A}/run/:runId`: one run with its steps and the usage of each step. */
export type RunDetail = RunSummary & {
    /** The step rows of the run, in the order of the ledger. */
    steps: RunStepSummary[];
    /**
     * What the calls of the run that belong to no step consumed (the plan and the synthesis frames), or
     * `null` when each call has a step or the usage read failed. The run `usage` counts these calls, and no
     * step shows them.
     */
    unattributedUsage: UsageTotals | null;
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
export type DataProfileView = { status: null } | (DataProfileState & { usage?: UsageTotals });

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
         * Why the last composition of the farm of this analysis failed, or `null`. The read consumes the
         * record, thus the next sandbox action composes again.
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
