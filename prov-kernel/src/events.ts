import type { ProvDocument } from "@inflexa-ai/tsprov";
import type { ProvDocumentModel, ProvDocumentModelInternal } from "./document.js";
import type {
    ProvActor,
    ProvCallRef,
    ProvCommandRef,
    ProvFileRef,
    ProvInputRef,
    ProvModelId,
    ProvReportBlockRef,
    ProvReportDerivationRef,
    ProvReportPreviewRef,
    ProvReportTitleRef,
    ProvReportVersionRef,
    ProvRunOutcome,
    ProvRunRef,
    ProvSessionRef,
    ProvStepOutcome,
    ProvStepRef,
    ProvUsedInputRef,
} from "./types.js";

/**
 * The core provenance event union — the facts every Inflexa producer records, in three families:
 * the analysis lifecycle, the execution, and the session and report acts. Each event carries the
 * owning `analysisId` and the responsible {@link ProvActor}; a model-driven event also carries the
 * {@link ProvModelId} that reasoned about it. A host records its own extension event kinds through
 * `appendLifecycleAction` and the QName derivations, outside this union.
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
          model: ProvModelId;
          file: ProvFileRef;
          /** Which activity owns the file's generation edge: a producing command, the bare step, or a file-tool call. */
          generation: "command" | "step" | "call";
          /** The generating file-tool call — required when `generation` is `"call"`. */
          call?: ProvCallRef;
          /** The owning step — required when `generation` is `"step"`; scopes a step-side call QName when present. */
          step?: ProvStepRef;
      }
    | { type: "input_used"; analysisId: string; actor: ProvActor; step: ProvStepRef; input: ProvUsedInputRef }
    | { type: "session_created"; analysisId: string; actor: ProvActor; model: ProvModelId; session: ProvSessionRef }
    | { type: "report_block_added"; analysisId: string; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "report_block_changed"; analysisId: string; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "report_block_removed"; analysisId: string; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "report_block_moved"; analysisId: string; actor: ProvActor; model: ProvModelId; block: ProvReportBlockRef }
    | { type: "report_title_set"; analysisId: string; actor: ProvActor; model: ProvModelId; title: ProvReportTitleRef }
    | { type: "report_derivation_run"; analysisId: string; actor: ProvActor; model: ProvModelId; derivation: ProvReportDerivationRef }
    | { type: "report_previewed"; analysisId: string; actor: ProvActor; model: ProvModelId; preview: ProvReportPreviewRef }
    | { type: "report_version_recorded"; analysisId: string; actor: ProvActor; model: ProvModelId; version: ProvReportVersionRef };

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
            // The optionality of `call` and `step` is per-generation, not global: a step-anchored
            // generation without its step (or a call without its call ref) has no activity to draw
            // the edge to, and silently skipping the edge would drop the file's sole generation.
            if (event.generation === "step" && event.step === undefined) {
                throw new Error('file_written with generation "step" requires a step ref');
            }
            if (event.generation === "call" && event.call === undefined) {
                throw new Error('file_written with generation "call" requires a call ref');
            }
            m.appendFileWritten(doc, event.analysisId, event.actor, event.file, event.generation, event.model, event.call, event.step);
            return;
        case "input_used":
            m.appendInputUsed(doc, event.analysisId, event.actor, event.step, event.input);
            return;
        case "session_created":
            m.appendSessionCreated(doc, event.analysisId, event.actor, event.session, event.model);
            return;
        case "report_block_added":
            m.appendReportBlockAdded(doc, event.analysisId, event.actor, event.block, event.model);
            return;
        case "report_block_changed":
            m.appendReportBlockChanged(doc, event.analysisId, event.actor, event.block, event.model);
            return;
        case "report_block_removed":
            m.appendReportBlockRemoved(doc, event.analysisId, event.actor, event.block, event.model);
            return;
        case "report_block_moved":
            m.appendReportBlockMoved(doc, event.analysisId, event.actor, event.block, event.model);
            return;
        case "report_title_set":
            m.appendReportTitleSet(doc, event.analysisId, event.actor, event.title, event.model);
            return;
        case "report_derivation_run":
            m.appendReportDerivationRun(doc, event.analysisId, event.actor, event.derivation, event.model);
            return;
        case "report_previewed":
            m.appendReportPreviewed(doc, event.analysisId, event.actor, event.preview, event.model);
            return;
        case "report_version_recorded":
            m.appendReportVersionRecorded(doc, event.analysisId, event.actor, event.version, event.model);
            return;
        default: {
            const never: never = event;
            throw new Error(`unhandled prov event type: ${String(never)}`);
        }
    }
}
