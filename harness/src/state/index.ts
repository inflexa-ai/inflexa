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

export { upsertAnalysis, loadAnalysisStatus } from "./analyses.js";

export {
    upsertArtifact,
    upsertArtifacts,
    queryInputArtifacts,
    queryStepArtifactPaths,
    queryUnsyncedStepArtifacts,
    updateArtifactId,
    updateFileIds,
    queryArtifactPage,
    queryArtifactOrigins,
    countArtifactsByRuns,
} from "./artifacts.js";
export type {
    RegisterArtifactInput,
    ArtifactOrigin,
    InputArtifactMeta,
    StepArtifactRef,
    ArtifactExtensionCount,
    ArtifactPage,
    ArtifactPageEntry,
    ArtifactPageQuery,
    ArtifactPageSort,
    RunArtifactCount,
} from "./artifacts.js";

export {
    insertRun,
    reserveRunById,
    RunDedupCollisionError,
    RunIdentityCollisionError,
    updateRunStatus,
    reconcileOrphanedRuns,
    ORPHANED_RUN_GRACE_MS,
    markRunCanceledIfActive,
    promoteFailedToPartial,
    setRunMandate, // oss-core-managed-ok: run-mandate ledger (nullable; OSS leaves null)
    setRunSynthesisOutcome,
    queryRun,
    queryActiveRun,
    queryNonTerminalRunsByAnalysis,
    queryRunsForInspection,
    queryRunsByAnalysis,
    countRunsByAnalysis,
    queryRunsByThread,
    queryRunIdsByPlan,
    queryNewestPlanRun,
} from "./runs.js";
export type { InsertRunInput, RunPage, RunReservation } from "./runs.js";

export {
    insertStepExecution,
    seedStepExecutions,
    sweepPendingStepExecutions,
    updateStepExecution,
    queryStepsByRun,
    countStepsByRuns,
} from "./step-executions.js";
export type { InsertStepExecutionInput, RunStepCounts, SeedStepExecutionRow, UpdateStepExecutionInput } from "./step-executions.js";

export { insertPlan, upsertPlan, loadPlan, loadPlanRecord, queryPlanPage } from "./plans.js";
export type { InsertPlanInput, UpsertPlanInput, PlanRecord, PlanRowQuerier, PlanPage, PlanPageEntry } from "./plans.js";

export {
    tryStartDataProfile,
    tryRetryDataProfile,
    tryRerunDataProfile,
    completeDataProfile,
    failDataProfile,
    expireStaleDataProfile,
    reconcileOrphanedDataProfile,
    clearDataProfile,
    completeEmptyDataProfile,
    loadDataProfileStatus,
    loadSeedInputFileIds,
    recordDataProfileWorkflowId,
} from "./data-profile.js";
export type {
    DataProfileStatus,
    DataProfileTerminalWrite,
    DataProfileResult,
    DataProfileChecked,
    DataProfileCompanionCompleteness,
    DataProfileDimension,
    DataProfileGroup,
    DataProfileGroupSlot,
    DataProfileFile,
    DataProfileMemberAnnotation,
    DataProfileObservation,
    DataProfilePartition,
    DataProfileProbeReport,
    DataProfileQualityAssessment,
    DataProfileQuarantine,
    DataProfileRecipeStep,
    DataProfileKind,
    DataProfileAxis,
    DataProfileInputSignature,
    DataProfileCoverage,
} from "./data-profile.js";

export {
    queryRunCountsByAnalyses,
    queryThreadCountsByAnalyses,
    queryDataProfileStatusByAnalyses,
    queryLatestRunsByAnalyses,
    queryRunProgressByRuns,
    queryRunsEndedSince,
} from "./analyses-metrics.js";
export type { DataProfileSummary, EndedRunSummary, LatestRunSummary, RunProgressSummary } from "./analyses-metrics.js";

// Not per-entity: one analysis's whole Postgres footprint, reached from its id
// alone, with the workflow ledger behind an injected seam.
export { createAnalysisPurge } from "./purge-analysis.js";
export type { AnalysisPurge, AnalysisPurgeDeps, AnalysisPurgeOutcome } from "./purge-analysis.js";

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
export type { AnalysisStateRow, ArtifactRow, CortexRunRow, StepExecutionRow, CortexPlanRow, TerminalRunStatus } from "./schema.js";
