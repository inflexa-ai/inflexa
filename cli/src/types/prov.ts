/**
 * The provenance domain model: the kinds of tracked actions and the agent responsible for one.
 * These outlive any single storage choice — an analysis's provenance is a PROV document
 * (serialized as PROV-JSON onto `analyses.provenance`), built incrementally by the recorder in
 * `modules/prov/prov.ts` from the typed `prov.*` bus events that carry these shapes.
 */

/**
 * Who is responsible for an action. `user` is a logged-in person (their email), `anonymous` an
 * unauthenticated person, `system` the inflexa CLI itself acting autonomously (carries its version).
 */
export type ProvActorKind = "user" | "anonymous" | "system";

/**
 * The resolved responsible agent for an action — a discriminated union so the call site states
 * *which* kind it is recording, and so the document builder reads the right fields per kind.
 */
export type ProvActor =
    | { kind: "user"; email: string }
    | { kind: "anonymous" }
    | {
          kind: "system";
          /** The CLI's package version. */
          version: string;
          /** The exact source commit — baked at build time, resolved from git in dev. */
          commit: string;
      };

/**
 * The subset of an analysis input that provenance records: the identity fields for the PROV
 * entity (stable QName from anchor+path) and the attributes written onto it. The owning
 * `analysisId` is not needed — the analysis subject is already in the document.
 */
export type ProvInputRef = {
    path: string;
    isDir: boolean;
    anchorId: string | null;
};

/**
 * A workflow run at its start — the bridge between the analysis lifecycle and the host-agnostic
 * harness execution. Carried by `prov.run_started`; recorded as a PROV **activity**.
 */
export type ProvRunRef = {
    /** The harness run's identity; the deterministic run-activity QName derives from it. */
    runId: string;
    /** The harness's plan summary for this run, when the seam supplies one (harness vocabulary — deliberately not the cli's "goal"). */
    planSummary?: string;
    /**
     * Epoch-ms the harness observed the run start, read from its checkpointed clock (`DBOS.now()`)
     * — the same value across every DBOS replay, NOT a cli receipt time. Builders convert it to the
     * run activity's formal `prov:startTime`, so the recorded start is the true workflow boundary
     * even when the flush-surviving observation happens on a later recovery boot.
     */
    startedAtMs: number;
};

/**
 * The terminal outcome of a workflow run. Carried by `prov.run_completed`; recorded as the run
 * activity's end time and outcome status.
 */
export type ProvRunOutcome = {
    /** Identifies the run whose activity this completion closes — matches the `run_started` `runId`. */
    runId: string;
    /** The harness's terminal run status (its `RunStatus` minus the non-terminal `"running"`); both the success and failure boundary sites resolve to one of these. */
    status: "completed" | "partial" | "failed" | "canceled" | "suspended_insufficient_funds";
    /**
     * Epoch-ms the harness observed the run terminate, from its checkpointed clock — replay-stable,
     * never a cli receipt time. Builders convert it to the run activity's formal `prov:endTime`.
     */
    completedAtMs: number;
    /** Harness-observed run duration (terminal minus start `DBOS.now()` reads); the seam always supplies it on completion. */
    durationMs?: number;
};

/**
 * A pure reference to a workflow step within a run — the identity a file generation or an input read
 * edges to. Carried by `prov.file_written` and `prov.input_used`; recorded as (a reference to) a PROV
 * **activity**. Settlement facts (status, times, duration) live on {@link ProvStepOutcome}, not here —
 * this is deliberately just the `(runId, stepId)` key so a file/input edge never carries stale
 * lifecycle data. Command strings and exit codes are absent by the same producer-model split.
 */
export type ProvStepRef = {
    /** The owning run — the step activity is `wasInformedBy` this run's activity. */
    runId: string;
    /** The step's identity within its run; the step-activity QName derives from `(runId, stepId)`. */
    stepId: string;
};

/**
 * The settlement outcome of a workflow step. Carried by `prov.step_completed`; recorded as the step
 * activity's end time, terminal status, and optional duration. Emitted at the harness scheduler
 * settlement (the only site that observes every executed step — including zero-artifact and failed
 * ones), never at artifact registration.
 */
export type ProvStepOutcome = {
    /** The owning run — the step activity is `wasInformedBy` this run's activity. */
    runId: string;
    /** The step's identity within its run; the step-activity QName derives from `(runId, stepId)`. */
    stepId: string;
    /** The settlement outcome mapped to a terminal step status (the scheduler's `complete`/`failed`/`canceled` mapping). */
    status: "completed" | "failed" | "canceled";
    /**
     * Epoch-ms the harness observed the step settle, from its checkpointed clock — replay-stable,
     * never a cli receipt time. Builders convert it to the step activity's formal `prov:endTime`.
     */
    completedAtMs: number;
    /** The child's durable execution duration, when the settlement carried one (absent when the child settled by throwing). */
    durationMs?: number;
};

/**
 * A file a step READ — an attested input consumed during execution. Carried by `prov.input_used`;
 * recorded as a PROV **entity** in the SAME `(path, hash)` QName space as {@link ProvFileRef} outputs,
 * so a `source: "prior"` read of an earlier run's output resolves to the very entity that run's
 * `prov.file_written` generated (cross-run lineage merges for free under `unified()`).
 */
export type ProvUsedInputRef = {
    /** Analysis-relative path (container mount prefix stripped); with `hash`, seeds the shared file QName. */
    path: string;
    /** Content hash attested from disk by the harness — the other half of the deterministic file QName, so an input read of unchanged bytes dedups onto the producing file's entity. */
    hash: string;
    /** The harness's read-classification, minus the step's own `"artifacts"` outputs: staged data, an upstream sibling's output, or a prior run's output. */
    source: "data" | "upstream" | "prior";
    /** The staged-input file id, when the harness resolved one (data-mount reads carry it; command/prior reads may not). */
    fileId?: string;
};

/**
 * A file produced under the analysis output tree — a sandbox command output or an agent file-tool
 * write. Carried by `prov.file_written`; recorded as a PROV **entity** generated by its step.
 */
export type ProvFileRef = {
    /** Analysis-scoped path (`runs/{runId}/{stepId}/…`); passes through unprefixed and, with the hash, seeds the file QName. */
    path: string;
    /** Content hash captured at write time — the other half of the deterministic file QName, so identical bytes dedup. */
    hash: string;
    /** File size in bytes. */
    size: number;
    /** How the bytes came to exist, in the harness's bare `Producer.type` vocabulary. */
    producer: "command" | "file_tool";
};

/**
 * The outcome of `inflexa prov verify`: one of several mutually exclusive states, each with enough
 * detail for the CLI/TUI to render a clear message.
 */
export type VerifyResult =
    | { status: "valid" }
    | { status: "unsigned" }
    | { status: "tampered"; detail: string }
    | { status: "no-key" }
    | { status: "empty" }
    | { status: "invalid-sidecar"; detail: string }
    | { status: "invalid-key" }
    | { status: "verify-error"; detail: string };
