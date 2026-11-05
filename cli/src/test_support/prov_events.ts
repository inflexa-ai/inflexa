import { applyProvEvent } from "@inflexa-ai/prov-kernel";
import { ProvDocument } from "@inflexa-ai/tsprov";

import type { Analysis } from "../types/analysis.ts";
import type {
    ProvActor,
    ProvCallRef,
    ProvCommandRef,
    ProvFileRef,
    ProvInputRef,
    ProvModelId,
    ProvRunRef,
    ProvRunOutcome,
    ProvStepOutcome,
    ProvStepRef,
    ProvUsedInputRef,
} from "../types/prov.ts";
import { provModel, provSubject } from "../modules/prov/document.ts";

// Statement production goes through `applyProvEvent` (the kernel's sole supported producer); these
// helpers keep the per-builder call shape the prov fixtures were written against, so a document reads
// as the sequence of events that produced it rather than as kernel plumbing.

/** A document over the prov subject of `a`, ready for the append helpers. */
export function freshDocument(a: Analysis): ProvDocument {
    return provModel.freshDocument(provSubject(a));
}

/** The creation statement of the analysis. */
export function appendCreation(doc: ProvDocument, analysisId: string, actor: ProvActor): void {
    applyProvEvent(provModel, doc, { type: "analysis_created", analysisId, actor });
}

/** An input added to the analysis scope, possibly derived from another analysis's outputs. */
export function appendInputAdded(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef, derivedFromAnalysisId: string | null): void {
    applyProvEvent(provModel, doc, { type: "input_added", analysisId, actor, input, derivedFromAnalysisId });
}

/** An input removed from the analysis scope. */
export function appendInputRemoved(doc: ProvDocument, analysisId: string, actor: ProvActor, input: ProvInputRef): void {
    applyProvEvent(provModel, doc, { type: "input_removed", analysisId, actor, input });
}

/** A run opened under the analysis. */
export function appendRunStarted(doc: ProvDocument, analysisId: string, actor: ProvActor, run: ProvRunRef): void {
    applyProvEvent(provModel, doc, { type: "run_started", analysisId, actor, run });
}

/** A run closed with its outcome. */
export function appendRunCompleted(doc: ProvDocument, analysisId: string, actor: ProvActor, outcome: ProvRunOutcome): void {
    applyProvEvent(provModel, doc, { type: "run_completed", analysisId, actor, outcome });
}

/** A step closed with its outcome, attributed to the model that drove it. */
export function appendStepCompleted(doc: ProvDocument, analysisId: string, actor: ProvActor, outcome: ProvStepOutcome, stepModel: ProvModelId): void {
    applyProvEvent(provModel, doc, { type: "step_completed", analysisId, actor, outcome, model: stepModel });
}

/** A command executed within a step, attributed to the model that drove the step. */
export function appendCommandExecuted(
    doc: ProvDocument,
    analysisId: string,
    actor: ProvActor,
    step: ProvStepRef,
    command: ProvCommandRef,
    stepModel: ProvModelId,
): void {
    applyProvEvent(provModel, doc, { type: "command_executed", analysisId, actor, step, command, model: stepModel });
}

/**
 * A file written by a run's artifact: `generation` says which artifact wrote it, and `step` names the
 * step when the writer was a command or a step. The model is the fixture's own value, passed where
 * the kernel's statement carries it.
 */
export function appendFileWritten(
    doc: ProvDocument,
    analysisId: string,
    actor: ProvActor,
    model: ProvModelId,
    file: ProvFileRef,
    step: ProvStepRef | undefined,
    generation: "command" | "step" | "call",
    call?: ProvCallRef,
): void {
    applyProvEvent(provModel, doc, { type: "file_written", analysisId, actor, model, file, generation, call, step });
}

/** An input read within a step. */
export function appendInputUsed(doc: ProvDocument, analysisId: string, actor: ProvActor, step: ProvStepRef, input: ProvUsedInputRef): void {
    applyProvEvent(provModel, doc, { type: "input_used", analysisId, actor, step, input });
}
