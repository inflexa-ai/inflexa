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
    /**
     * The harness's terminal run status. The run body resolves BOTH boundary sites through
     * `deriveFinalStatus`, which records a budget pause as `"canceled"` — so
     * `"suspended_insufficient_funds"` (a `RunStatus` member) is never emitted and is deliberately
     * absent here. Widen this only when the harness actually emits a new terminal status; the bridge's
     * `event.status → outcome.status` assignment is the compile-time check that keeps the two in step.
     */
    status: "completed" | "partial" | "failed" | "canceled";
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
 * The `(path, hash)` identity pick of {@link ProvFileRef} — the QName key space every file entity
 * lives in. A command's outputs and its command-scoped reads carry only this pair (no size/producer),
 * so an intra-step self-read or a cross-run prior read keys onto the very entity the producing write
 * registered. Named (not an inline `Pick`) so the shared key space reads as one type at every use site.
 */
export type ProvFileKey = Pick<ProvFileRef, "path" | "hash">;

/**
 * A file a COMMAND read — the command-scoped analogue of {@link ProvUsedInputRef}, carried only inside
 * {@link ProvCommandRef}. It widens the used-input source vocabulary with `"step"`: a resolved
 * intra-step self-read (command B reading command A's output within one step) — a chain edge the
 * step-level {@link ProvUsedInputRef} vocabulary never carries, because at STEP scope "the step read
 * its own output" is noise (skipped), while at COMMAND scope it is exactly the intra-step lineage signal.
 */
export type ProvCommandInputRef = {
    /** Analysis-relative path; with `hash`, keys the shared file QName so the read merges onto the producing write's entity. */
    path: string;
    /** Content hash attested from disk by the harness — the other half of the deterministic file QName. */
    hash: string;
    /** The read classification: staged data, an upstream sibling's output, a prior run's output, or `"step"` for a resolved intra-step self-read. */
    source: "data" | "upstream" | "prior" | "step";
    /** The staged-input file id, when the harness resolved one (data-mount reads carry it; command/prior reads may not). */
    fileId?: string;
};

/**
 * One execution inside a step that produced files — a discriminated union over the harness's two
 * producer kinds, mirroring the collector's `Producer` shape. Carried by `prov.command_executed`; the
 * `command` variant records as a PROV **activity** typed `inflexa:Command`, the `file_tool` variant as
 * `inflexa:FileToolWrite`. One ref per surviving producer group: the collector is last-write-wins per
 * output path, so after collapse a group is uniquely keyed by its OUTPUT SET (never the producer's
 * object identity, which is meaningless across a DBOS workflow re-execution).
 *
 * NO timestamp field by design: the producer's observation timestamp is re-minted on every DBOS replay
 * (replay-unstable), so it must never cross the bus into an identifier or a formal PROV position. The
 * command activity therefore carries no formal start/end time at all — its ordering lives on the
 * `wasInformedBy` edge to its step, and the step already carries replay-stable settlement times.
 */
export type ProvCommandRef =
    | {
          kind: "command";
          /** The command line the sandbox executed. */
          command: string;
          /** The command's argument vector, when the collector captured one. */
          args?: string[];
          /** The process exit code. */
          exitCode: number;
          /** Execution duration in ms, when captured — a relative span (replay-stable), NOT an observation timestamp. */
          durationMs?: number;
          /** The script the command ran, when it read one; resolved to a registered entity via the group's own outputs/inputs by the builder (skipped if unresolvable — the ref carries no hash). */
          scriptPath?: string;
          /** The files this command wrote — its generation authority; each keys a file entity. */
          outputs: ProvFileKey[];
          /** The command's command-scoped reads: data/upstream/prior reads plus resolved intra-step self-reads (`source: "step"`). */
          inputs: ProvCommandInputRef[];
      }
    | {
          kind: "file_tool";
          /** The agent file-tool that authored the content (e.g. `write_file`). */
          tool: string;
          /** The files the tool wrote; a file-tool write carries no inputs by construction (agent-authored content). */
          outputs: ProvFileKey[];
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
