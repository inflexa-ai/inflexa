import type { AnalysisId } from "./analysis.ts";
import type {
    ProvActor,
    ProvInputRef,
    ProvModelId,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvCallRef,
    ProvCommandRef,
    ProvSessionRef,
    ProvReportBlockRef,
    ProvReportTitleRef,
    ProvReportDerivationRef,
    ProvReportPreviewRef,
    ProvReportVersionRef,
} from "./prov.ts";

/**
 * A run's live shape as the embedded runtime reports it — the payload of `run.observed`.
 *
 * Structurally the harness's `RunObservation`, restated here as cli-owned primitives rather than
 * re-exported: the bus contract is the cli's, and every other member of this union is likewise a
 * cli type. Restating it also keeps the compile error at the adapter (`run_bridge.ts`) if the
 * harness widens its snapshot, rather than letting a new field silently reach subscribers.
 */
export type RunObservedSnapshot = {
    runId: string;
    /** `running` mid-flight; the run's terminal status on the last snapshot. */
    status: "running" | "completed" | "partial" | "failed" | "canceled";
    /** Every plan step, including ones not yet started — never a delta. */
    steps: readonly {
        id: string;
        /** The plan author's phrase for the step; falls back to its id when the plan has none. */
        name: string;
        agent: string;
        status: "pending" | "queued" | "running" | "completed" | "failed" | "skipped";
        durationMs?: number;
        error?: string;
    }[];
};

/**
 * The cross-process event contract. Members fall in two families: analysis-scoped **provenance**
 * (`prov.*`), which closes a signed hash chain under the single-writer instance lock, and
 * analysis-scoped **run observation** (`run.*`), a lossy-tolerant channel that drives presentation.
 * Both travel this one bus, separated by type string — never a second bus instance (see the
 * event-bus spec).
 *
 * The two families are deliberately independent: a `run.*` member is never derived from or emitted
 * as a side effect of a `prov.*` one. Reusing `prov.run_completed` to drive a repaint would put
 * that repaint behind the chain's write discipline and force provenance to record step names and
 * agent ids it has no reason to hold.
 *
 * The union holds only members with a live emitter AND consumer; the harness conversation
 * path writes the Solid store directly rather than through the bus, so no session/chat
 * members belong here.
 *
 * One event type per domain action — never a single "recorded" event discriminated
 * by an interior `action` field with nullable companions. Each member carries exactly
 * the fields its action needs, no more (see "Single bus, typed events" in CLAUDE.md).
 */
export type BusEvent =
    | {
          type: "run.observed";
          analysisId: AnalysisId;
          /**
           * The whole run, not a transition. The embedded runtime re-delivers this after a durable
           * recovery, so a subscriber that only renders needs no dedupe — the newest snapshot is the
           * whole truth. A subscriber taking a DURABLE action must key it by `runId` and `status`.
           */
          snapshot: RunObservedSnapshot;
      }
    | { type: "prov.analysis_created"; analysisId: AnalysisId; actor: ProvActor }
    | {
          type: "prov.input_added";
          analysisId: AnalysisId;
          actor: ProvActor;
          input: ProvInputRef;
          /** Set when the input is itself another analysis's output — links the two PROV subjects. */
          derivedFromAnalysisId: string | null;
      }
    | { type: "prov.input_removed"; analysisId: AnalysisId; actor: ProvActor; input: ProvInputRef }
    | { type: "prov.run_started"; analysisId: AnalysisId; actor: ProvActor; run: ProvRunRef }
    | { type: "prov.run_completed"; analysisId: AnalysisId; actor: ProvActor; outcome: ProvRunOutcome }
    | {
          type: "prov.step_completed";
          analysisId: AnalysisId;
          actor: ProvActor;
          outcome: ProvStepOutcome;
          /**
           * The model that drove the step — REQUIRED so a forgotten wiring is a compile error at the
           * emit site, never a silent gap in exactly the record this field exists to make. Rides the
           * event (like `generation` on `prov.file_written`) so the recorder never infers it across
           * events.
           */
          model: ProvModelId;
      }
    | {
          type: "prov.command_executed";
          analysisId: AnalysisId;
          actor: ProvActor;
          step: ProvStepRef;
          command: ProvCommandRef;
          /** The model that drove the producing step — see `prov.step_completed`'s `model`. */
          model: ProvModelId;
      }
    | {
          type: "prov.file_written";
          analysisId: AnalysisId;
          actor: ProvActor;
          /** The model that drove the writing agent — used by the kernel only in the `call` arm. */
          model: ProvModelId;
          file: ProvFileRef;
          /**
           * Which activity owns this file's generation edge: `"command"` when a producer group's
           * `prov.command_executed` writes it (the bridge bucketed the file as produced), `"step"` for
           * a leaf file (no producer record — e.g. an inotify-only observation) that keeps the
           * step-level generation fallback, `"call"` for a file-tool write (a step-scoped file-tool
           * producer group, or a conversation-turn write with no run and no step). The bridge's
           * bucket decision rides the event so the recorder never has to infer it across events.
           */
          generation: "command" | "step" | "call";
          /** The generating file-tool call — present exactly when `generation` is `"call"`. */
          call?: ProvCallRef;
          /** The producing step — required for `"step"`; scopes a step-side call; absent on a session write. */
          step?: ProvStepRef;
      }
    | { type: "prov.input_used"; analysisId: AnalysisId; actor: ProvActor; step: ProvStepRef; input: ProvUsedInputRef }
    /**
     * The report family. The agent performs each of these acts, so every member stamps the SYSTEM
     * actor and carries the model that drove the session at emit time — the same treatment
     * `prov.step_completed` gives a model-driven step, and the reason `model` is required rather
     * than optional here too. The user steers the agent; recording that steering is a separate
     * concern from recording who acted.
     *
     * Every payload ref is a kernel shape, `ProvReportBlockRef`'s `blockKind` included, so the
     * recorder hands the whole family straight to the kernel dispatch. A widened kernel shape thus
     * reaches this contract only through the pin, never silently.
     */
    | { type: "prov.session_created"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; session: ProvSessionRef }
    | { type: "prov.report_block_added"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "prov.report_block_changed"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "prov.report_block_removed"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "prov.report_block_moved"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "prov.report_title_set"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; title: ProvReportTitleRef }
    | { type: "prov.report_derivation_run"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; derivation: ProvReportDerivationRef }
    | { type: "prov.report_previewed"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; preview: ProvReportPreviewRef }
    | { type: "prov.report_version_recorded"; analysisId: AnalysisId; actor: ProvActor; model: ProvModelId; version: ProvReportVersionRef };

/** A {@link BusEvent} stamped with a unique id by the bus on emit (for telemetry correlation). */
export type StampedEvent = BusEvent & { __infId: string };
