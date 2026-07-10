import type { AnalysisId } from "./analysis.ts";
import type {
    ProvActor,
    ProvInputRef,
    ProvModelRef,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvCommandRef,
} from "./prov.ts";

/**
 * The cross-process event contract. Today every member is an analysis-scoped provenance
 * event carrying `analysisId`; a future domain adds its own member here (see the event-bus
 * spec). The union holds only members with a live emitter AND consumer; the harness conversation
 * path writes the Solid store directly rather than through the bus, so no session/chat
 * members belong here.
 *
 * One event type per domain action — never a single "recorded" event discriminated
 * by an interior `action` field with nullable companions. Each member carries exactly
 * the fields its action needs, no more (see "Single bus, typed events" in CLAUDE.md).
 */
export type BusEvent =
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
          model: ProvModelRef;
      }
    | {
          type: "prov.command_executed";
          analysisId: AnalysisId;
          actor: ProvActor;
          step: ProvStepRef;
          command: ProvCommandRef;
          /** The model that drove the producing step — see `prov.step_completed`'s `model`. */
          model: ProvModelRef;
      }
    | {
          type: "prov.file_written";
          analysisId: AnalysisId;
          actor: ProvActor;
          file: ProvFileRef;
          step: ProvStepRef;
          /**
           * Which activity owns this file's generation edge: `"command"` when a producer group's
           * `prov.command_executed` writes it (the bridge bucketed the file as produced), `"step"` for
           * a leaf file (no producer record — e.g. an inotify-only observation) that keeps the
           * step-level generation fallback. The bridge's produced-vs-leaf decision rides the event so
           * the recorder never has to infer it across events.
           */
          generation: "command" | "step";
      }
    | { type: "prov.input_used"; analysisId: AnalysisId; actor: ProvActor; step: ProvStepRef; input: ProvUsedInputRef };

/** A {@link BusEvent} stamped with a unique id by the bus on emit (for telemetry correlation). */
export type StampedEvent = BusEvent & { __infId: string };
