import type { ProvDocument } from "@inflexa-ai/tsprov";
import type { ProvDocumentModel, ProvDocumentModelInternal } from "./document.js";
import type {
    ProvActor,
    ProvCommandRef,
    ProvFileRef,
    ProvInputRef,
    ProvModelId,
    ProvRunOutcome,
    ProvRunRef,
    ProvStepOutcome,
    ProvStepRef,
    ProvUsedInputRef,
} from "./types.js";

/**
 * The core provenance event union — the nine facts every Inflexa producer records. Each event
 * carries the owning `analysisId` and the responsible {@link ProvActor}; a model-driven execution
 * event also carries the {@link ProvModelId} that reasoned about it. A host records its own
 * extension event kinds through `appendLifecycleAction` and the QName derivations, outside this
 * union.
 */
export type ProvEvent =
    | { type: "analysis_created"; analysisId: string; actor: ProvActor }
    | {
          type: "input_added";
          analysisId: string;
          actor: ProvActor;
          input: ProvInputRef;
          derivedFromAnalysisId: string | null;
      }
    | { type: "input_removed"; analysisId: string; actor: ProvActor; input: ProvInputRef }
    | { type: "run_started"; analysisId: string; actor: ProvActor; run: ProvRunRef }
    | { type: "run_completed"; analysisId: string; actor: ProvActor; outcome: ProvRunOutcome }
    | {
          type: "step_completed";
          analysisId: string;
          actor: ProvActor;
          outcome: ProvStepOutcome;
          model: ProvModelId;
      }
    | {
          type: "command_executed";
          analysisId: string;
          actor: ProvActor;
          step: ProvStepRef;
          command: ProvCommandRef;
          model: ProvModelId;
      }
    | {
          type: "file_written";
          analysisId: string;
          actor: ProvActor;
          file: ProvFileRef;
          step: ProvStepRef;
          generation: "command" | "step";
      }
    | { type: "input_used"; analysisId: string; actor: ProvActor; step: ProvStepRef; input: ProvUsedInputRef };

/**
 * Apply one core event to `doc` through the model's builders — the sole supported producer of
 * core statements. The event-to-statements mapping determines the serialized document bytes — the
 * same bytes the chain hash signs — thus the mapping is format and lives in the kernel. Hosts map
 * extension events onto `appendLifecycleAction`, the QName derivations, and tsprov interop
 * themselves.
 */
export function applyProvEvent(model: ProvDocumentModel, doc: ProvDocument, event: ProvEvent): void {
    // Every model comes from `createProvDocumentModel`, so the builders exist at runtime; the
    // public type omits them to keep this switch the only core-statement producer.
    const m = model as ProvDocumentModelInternal;
    switch (event.type) {
        case "analysis_created":
            m.appendCreation(doc, event.analysisId, event.actor);
            return;
        case "input_added":
            m.appendInputAdded(doc, event.analysisId, event.actor, event.input, event.derivedFromAnalysisId);
            return;
        case "input_removed":
            m.appendInputRemoved(doc, event.analysisId, event.actor, event.input);
            return;
        case "run_started":
            m.appendRunStarted(doc, event.analysisId, event.actor, event.run);
            return;
        case "run_completed":
            m.appendRunCompleted(doc, event.analysisId, event.actor, event.outcome);
            return;
        case "step_completed":
            m.appendStepCompleted(doc, event.analysisId, event.actor, event.outcome, event.model);
            return;
        case "command_executed":
            m.appendCommandExecuted(doc, event.analysisId, event.actor, event.step, event.command, event.model);
            return;
        case "file_written":
            m.appendFileWritten(doc, event.analysisId, event.actor, event.file, event.step, event.generation);
            return;
        case "input_used":
            m.appendInputUsed(doc, event.analysisId, event.actor, event.step, event.input);
            return;
        default: {
            const never: never = event;
            throw new Error(`unhandled prov event type: ${String(never)}`);
        }
    }
}
