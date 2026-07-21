/**
 * Cortex execution state module.
 *
 * Cortex-owned Postgres tables for analysis state, artifact registry,
 * and execution ledgers. Per-entity sub-modules live alongside this barrel;
 * importers may either pull from `./state` (everything) or from the
 * specific entity module (e.g. `./state/runs.js`) when narrow.
 */

export { initCortexState } from "./init.js";

export type { Querier } from "./db.js";

export { upsertAnalysis, resolveAnalysisBilling, suspendAnalysis, resumeAnalysis, loadAnalysisStatus } from "./analyses.js";

export {
    upsertArtifact,
    upsertArtifacts,
    queryInputArtifacts,
    queryStepArtifactPaths,
    queryUnsyncedStepArtifacts,
    updateArtifactId,
    updateFileIds,
    countArtifactsForRun,
} from "./artifacts.js";
export type { RegisterArtifactInput, InputArtifactMeta, StepArtifactRef } from "./artifacts.js";

export {
    insertRun,
    RunDedupCollisionError,
    updateRunStatus,
    promoteFailedToPartial,
    setRunMandate, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    setRunSynthesisOutcome,
    queryRun,
    queryActiveRun,
    queryRunsByAnalysis,
    queryRunsByThread,
} from "./runs.js";
export type { InsertRunInput } from "./runs.js";

export {
    insertStepExecution,
    seedStepExecutions,
    sweepPendingStepExecutions,
    updateStepExecution,
    queryStepsByRun,
    queryCompletedStepsByAnalysis,
} from "./step-executions.js";
export type { InsertStepExecutionInput, SeedStepExecutionRow, UpdateStepExecutionInput } from "./step-executions.js";

export { setSandboxRef, setActiveExecId, clearSandboxRef, queryActiveSandboxes, reconcileReapedSandbox } from "./active-sandboxes.js";
export type { ActiveSandboxRow } from "./active-sandboxes.js";

export { insertPlan, loadPlan } from "./plans.js";
export type { InsertPlanInput } from "./plans.js";

export {
    tryStartDataProfile,
    tryRetryDataProfile,
    tryRerunDataProfile,
    completeDataProfile,
    failDataProfile,
    expireStaleDataProfile,
    reconcileOrphanedDataProfile,
    clearDataProfile,
    loadDataProfileStatus,
    loadSeedInputFileIds,
} from "./data-profile.js";
export type { DataProfileStatus, DataProfileResult, DataProfileInputFile, DataProfileFile, DataProfileQualityAssessment } from "./data-profile.js";

export { queryRunCountsByAnalyses, queryThreadCountsByAnalyses, queryDataProfileStatusByAnalyses } from "./analyses-metrics.js";

export {
    AnalysisStateRowSchema,
    ArtifactRole,
    ArtifactRowSchema,
    RunStatus,
    StepExecutionStatus,
    SynthesisStatus,
    CortexRunRowSchema,
    StepExecutionRowSchema,
    CortexPlanRowSchema,
} from "./schema.js";
export type { AnalysisStateRow, ArtifactRow, CortexRunRow, StepExecutionRow, CortexPlanRow } from "./schema.js";

export {
    insertAssessment,
    updateProgress,
    setDossier,
    markFailed,
    getAssessment,
    listAssessmentsByOrg,
    softDeleteAssessment,
    TargetAssessmentStatusSchema,
    TargetAssessmentErrorSchema,
    TargetAssessmentRowSchema,
} from "./target-assessments.js";
export type {
    TargetAssessmentStatus,
    TargetAssessmentRow,
    TargetAssessmentError,
    InsertAssessmentInput,
    ListAssessmentsOptions,
} from "./target-assessments.js";
