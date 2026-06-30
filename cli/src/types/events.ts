import type { Message, Part } from "./session.ts";
import type { AnalysisId } from "./analysis.ts";
import type { ProvActor, ProvInputRef } from "./prov.ts";

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
    | { type: "prov.input_removed"; analysisId: AnalysisId; actor: ProvActor; input: ProvInputRef };

/** A {@link BusEvent} stamped with a unique id by the bus on emit (for telemetry correlation). */
export type StampedEvent = BusEvent & { __infId: string };
