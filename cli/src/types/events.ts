import type { Message, Part } from "./session.ts";
import type { AnalysisId } from "./analysis.ts";
import type {
    ProvActor,
    ProvInputRef,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepRef,
    ProvStepOutcome,
    ProvUsedInputRef,
    ProvFileRef,
    ProvCommandRef,
} from "./prov.ts";

/**
 * The cross-process event contract. Session-scoped events carry `sessionId`;
 * provenance events carry `analysisId` and are ignored by session-scoped consumers.
 *
 * One event type per domain action — never a single "recorded" event discriminated
 * by an interior `action` field with nullable companions. Each member carries exactly
 * the fields its action needs, no more (see "Single bus, typed events" in CLAUDE.md).
 */
export type BusEvent =
    | { type: "session.status"; sessionId: string; status: "idle" | "busy" | "error" }
    | { type: "message.created"; message: Message }
    | { type: "message.updated"; message: Message }
    | { type: "part.updated"; part: Part }
    | { type: "part.delta"; sessionId: string; messageId: string; partId: string; delta: string }
    | { type: "session.error"; sessionId: string; error: string }
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
    | { type: "prov.step_completed"; analysisId: AnalysisId; actor: ProvActor; outcome: ProvStepOutcome }
    | { type: "prov.command_executed"; analysisId: AnalysisId; actor: ProvActor; step: ProvStepRef; command: ProvCommandRef }
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
