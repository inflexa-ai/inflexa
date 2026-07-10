/**
 * Curated public interface for `@inflexa-ai/harness` — the embedder-facing
 * front door. Every deep subpath (`@inflexa-ai/harness/...`) remains
 * importable; this barrel exposes only the surface an embedder needs to wire
 * the agent with its own seam realizations.
 */

// Runtime assembly + composition root.
export { assembleCoreRuntime } from "./runtime/assemble.js";
export type { CoreRuntime, CoreRuntimeDeps, CoreWorkflowDeps, RegisteredWorkflows, ConversationAssemblyDeps, SandboxStepCallable } from "./runtime/assemble.js";

export { createConversationAgent } from "./agents/conversation-agent.js";
export type { ConversationAgentDeps } from "./agents/conversation-agent.js";

// Seam: run authorization.
export { createLocalRunAuthorizer } from "./auth/local-run-authorizer.js";
export type { RunAuthorizer, AuthorizeRunInput, RunAuthorization } from "./execution/run-authorizer.js";

// Seam: billing resolution.
export { createNoopBillingResolver } from "./billing/noop-resolver.js";
export type { ResolveBilling, ResolvableSession, BillingMap, BillingHeaders, BillingFetchResult } from "./billing/resolver.js";

// Seam: run-level billing bracket.
export { createNoopRunCharge } from "./billing/noop-run-charge.js";
export type { RunCharge } from "./billing/run-charge.js";

// Seam: artifact registration.
export { createNoopArtifactRegistry } from "./execution/noop-artifact-registry.js";
export type { ArtifactRegistry, ArtifactRegistrationInput, ArtifactSyncInput, ExternalRegistrationResult } from "./execution/artifact-registry.js";
// The `ArtifactRegistrationInput` payload types an embedder's `register` seam
// destructures: the reconciled manifest entries and the step-level lineage
// collector (the `provenance/collector.js` class that tracks a step's
// input/output edges).
export type { ArtifactManifestEntry } from "./schemas/artifact-manifest.js";
export type { ProvenanceCollector } from "./provenance/collector.js";

// Seam: report preview publishing.
export { UnavailablePreviewPublisher } from "./tools/report/preview-publisher.js";
export type { PreviewPublisher, PreviewMintResult } from "./tools/report/preview-publisher.js";

// Run launching.
export { createDbosRunLauncher } from "./execution/dbos-run-launcher.js";
export type { RunLauncher, LaunchOptions, LaunchRunOptions, LaunchOutcome } from "./execution/run-launcher.js";

// Tool primitive.
export { defineTool, isToolError } from "./tools/define-tool.js";
export type { Tool, ToolDefinition, ToolContext, ToolError } from "./tools/define-tool.js";

// Agent loop.
export { runAgent, finalText } from "./loop/run-agent.js";
export type { RunAgentOptions, RunAgentResult, AgentFinish } from "./loop/run-agent.js";
export type { AgentDefinition, RunStep, EmitFn, EmitEvent, EventSource } from "./loop/types.js";
// `passthroughStep` is the in-process `RunStep`: the host request/chat path runs
// the loop with no durability wrapper (workflow contexts use the durable step).
// An embedder driving `runAgent` outside a workflow passes it as `runStep`.
export { passthroughStep } from "./loop/run-step.js";

// Session value objects + helpers.
export { forStep, forSubAgent, scopeResource, scopeWorkloadId } from "./auth/types.js";
export type {
    AgentSession,
    RequestSession,
    RunSession,
    Identity,
    Scope,
    Credential,
    Provenance,
    RunFrame,
    AuthContext,
    ResourceCoordinates,
} from "./auth/types.js";
export { makeLocalAuth } from "./auth/local-auth-context.js";

// Providers.
export { createAnthropicProvider } from "./providers/anthropic.js";
export type { AnthropicProviderDeps } from "./providers/anthropic.js";
export { createEmbeddingProvider } from "./providers/embedding.js";
export type { EmbeddingProviderDeps } from "./providers/embedding.js";
export type { AgentChat, ChatProvider, EmbeddingProvider, ChatRequest, ChatResponse, ChatStreamEvent, ModelMessage } from "./providers/types.js";
// Provider error channel. `ProviderError` is the value `chat`/`embed` fail
// with; `toProviderError` is its sole constructor. Exposed so an embedder
// realizing its own `ChatProvider`/`EmbeddingProvider` fails with the exact
// same shape the harness's own realizations do, rather than re-deriving it.
// `isProviderError` is the structural guard an embedder driving `chatStream`
// directly needs: `chatStream` throws a `ProviderError` value (a plain object,
// not an `Error`), so a `catch` recognizes it by shape, not `instanceof`.
export { toProviderError, isProviderError } from "./providers/errors.js";
export type { ProviderError } from "./providers/errors.js";
// `createStreamingChat` wraps a `ChatProvider` as a streaming `AgentChat` (the
// type `runAgent`'s `provider` option takes): its `chat` drives the provider's
// `chatStream` and forwards each text delta to `onText`, so a same-process host
// gets live token streaming out of the otherwise non-streaming loop.
export { createStreamingChat } from "./providers/streaming-chat.js";

// Conversation turn + thread memory — the transport-free halves of one chat
// turn a same-process host drives itself. `prepareChatTurn` assembles the
// message array (thread-ownership resolution, title seed, analysis-context
// injection); the caller runs `runAgent` with its own `emit`; `appendTurn`
// (`createThreadHistory`) persists the turn. `createThreadStore` owns thread
// metadata (create/list/title). `contentToCortexMessages` + `createCardResolver`
// reconstruct display cards from a persisted thread on reload.
export { prepareChatTurn } from "./app/chat-turn.js";
export type { PrepareChatTurnDeps, PrepareChatTurnParams, PrepareChatTurnResult } from "./app/chat-turn.js";
export { createThreadStore } from "./memory/thread-store.js";
export type { ThreadStore, Thread, CreateThreadInput, ListThreadsInput, ThreadPage } from "./memory/thread-store.js";
export { createThreadHistory } from "./memory/thread-history.js";
export type { ThreadHistory, StoredMessage, MessagePage } from "./memory/thread-history.js";
export { contentToCortexMessages } from "./memory/content-to-cortex.js";
export { createCardResolver } from "./memory/reconstruct-cards.js";
export type { ToolCardResolver, StoredToolCallForCard } from "./memory/reconstruct-cards.js";

// Chat wire contracts — the Cortex-native chat-stream vocabulary a consumer
// rendering the stream types against. Two names are deliberately NOT re-exported
// here because the main barrel already binds them to other types: `EventSource`
// (already exported from `loop/types.js`, same `{ agentId, callPath }` shape —
// reach provenance through each event's `source`) and the chat-parts `PlanStep`
// (the barrel's `PlanStep` is the scheduler's `{ id, depends_on }`; a plan card's
// step type is `NonNullable<PlanPart["steps"]>[number]`). Both stay reachable via
// the `@inflexa-ai/harness/contracts/*` deep subpaths.
export type { CortexChatEvent, TextDeltaEvent, ToolStartedEvent, ToolFinishedEvent, FinishEvent, ChatErrorEvent } from "./contracts/chat-events.js";
export type {
    CortexChatPart,
    PresentationPart,
    PresentationContent,
    PlanPart,
    RunCardPart,
    FileReferencePart,
    FileReferenceEntry,
    RunStartedPart,
    DagStatePart,
    DagStepState,
    StepStatus,
    StepActivityPart,
    StepPhase,
    StepFileTreePart,
    FileTreeEntry,
    StepOutputPart,
    StepOutputFile,
    StepSummaryPart,
    StepBlockedPart,
    RunSynthesisPart,
    SynthesizedFinding,
    BiologicalTheme,
    SynthesisProgressPart,
    SynthesisPhase,
    RunCompletedPart,
    RunCompletedFinding,
    RunFailedPart,
    PreviewPart,
    DataPreviewFailedPart,
} from "./contracts/chat-parts.js";
export { PART_REGISTRY, isTransient, isReconciling, isSidebarPart } from "./contracts/part-registry.js";
export type { CortexChatPartType, PartDescriptor, PartEmitter, PartConsumer } from "./contracts/part-registry.js";

// Embedder runtime surface — what a same-process host needs to run durable
// workflows itself: the DBOS lifecycle, per-workflow registration + triggers,
// the staged-input manifest contract, the sandbox/workspace factories over its
// workspace tree, and the exec-callback envelope pieces (the HTTP→DBOS-topic
// ingress is the embedder's to host; see the sandbox-server callback protocol).

// DBOS lifecycle. `sweepEphemeralWorkflows` is a pre-launch boot duty: once the
// `ephemeral` workflow is registered, a host crash mid-run leaves a PENDING
// `ephemeral:*` row that the next launch's recovery would re-dispatch (a sandbox
// for a chat turn that no longer exists). The embedder sweeps it with a direct
// system-DB UPDATE between state-init and `launchDbos` — the only race-free point.
export { launchDbos, shutdownDbos, sweepEphemeralWorkflows } from "./runtime/dbos.js";
export type { DbosConfig } from "./runtime/dbos.js";
// DBOS workflow-status vocabulary. An embedder that reads its own
// `dbos.workflow_status` rows must classify them against the SDK's status set,
// but must never depend on `@dbos-inc/dbos-sdk` directly — the SDK is
// module-singleton state, so a host's own copy is a different, un-launched
// instance (same rationale as `deliverExecEvent` below). The barrel forwards the
// status const + its union so the classification vocabulary comes from the one
// launched SDK, not a drifting hand-kept string literal on the embedder side.
export { StatusString } from "@dbos-inc/dbos-sdk";
export type { WorkflowStatusString } from "@dbos-inc/dbos-sdk";

// Application pool. Exported so an embedder never declares its own `pg`
// dependency: the pool it hands to workflow deps is built by the same pg
// copy the harness queries with.
export { createPool } from "./lib/storage.js";
export type { PoolConfig } from "./lib/storage.js";
export type { Pool } from "pg";

// Data-profile workflow: registration + trigger. `triggerDataProfile` claims a
// startable row (`pending` or NULL status) or a `completed` one, in both cases only
// when the analysis names a non-empty seeded input set; a failed profile is re-claimed
// via `tryRetryDataProfile` and then started with `runDataProfile` (the managed retry
// route's shape — embedders mirror it).
export { registerDataProfileWorkflow, triggerDataProfile, runDataProfile } from "./tasks/data-profile.js";
export type {
    DataProfileDeps,
    DataProfileWorkflowInput,
    DataProfileTriggerDeps,
    DataProfileTriggerParams,
    DataProfileTriggerResult,
} from "./tasks/data-profile.js";

// Ledger surface the embedder needs around a trigger: schema init at boot,
// the analysis-state seed (the trigger's CAS transitions the row this creates
// — without it every trigger reports "failed"), and run-state observation.
export { initCortexState } from "./state/init.js";
export { upsertAnalysis } from "./state/analyses.js";
// `reconcileOrphanedDataProfile` heals a ledger row stuck at `running` with no
// backing workflow (a host that died between the ledger CAS and the DBOS
// insert) — the embedder calls it once after launch, when recovery has run.
// `clearDataProfile` nulls the whole profile ledger back to "no profile" when an
// analysis's input set empties (deferring on a running workflow), so the UI
// stops advertising a profile that describes files the analysis no longer has.
export { clearDataProfile, loadDataProfileStatus, tryRetryDataProfile, reconcileOrphanedDataProfile } from "./state/data-profile.js";
export type { DataProfileInputFile, DataProfileResult, DataProfileStatus } from "./state/data-profile.js";

// Staged-input manifest contract (the embedder stages; the harness only reads).
export type { StagedInput } from "./execution/staged-input.js";

// Sandbox + workspace seams over the embedder-resolved workspace roots.
// `ResolveWorkspaceRoot` is the location seam itself: the embedder maps each
// resource id to the absolute host directory of its workspace tree (see the
// workspace-root-resolution spec); every harness path derives from it.
export type { ResolveWorkspaceRoot } from "./workspace/paths.js";
export { createSandboxClient } from "./sandbox/create-sandbox.js";
export type { CreateSandboxClientConfig, SandboxBackendConfig } from "./sandbox/create-sandbox.js";
export type { SandboxClient } from "./sandbox/client.js";
export { MachineBudgetSchema, ResourceLimitsSchema, ResourcePolicySchema, ResourceSpecSchema, parseResourcePolicy } from "./config/resource-limits.js";
export type { MachineBudget, ResourceLimits, ResourcePolicy, ResourceSpec } from "./config/resource-limits.js";
export { createWorkspaceFilesystem } from "./workspace/filesystem.js";
export type { WorkspaceFilesystem, WorkspaceFilesystemDeps } from "./workspace/filesystem.js";

// Exec-callback ingress building blocks. Delivery goes through
// `deliverExecEvent` — never a host-side `DBOS.send`: the SDK is
// module-singleton state, and a host's own copy would be un-launched.
export { workflowIdFromExec } from "./sandbox/exec-id.js";
export { deliverExecEvent, execEventTopic } from "./sandbox/deliver-exec-event.js";
export { ExecEventMessageSchema } from "./sandbox/types.js";
export type { ExecEventMessage, DoneMarker } from "./sandbox/types.js";

// Run engine — the analysis + sandbox-step durable workflows an embedder
// registers itself (in child-before-parent assemble-order: the parent's deps
// close over the registered child callable). `assembleCoreRuntime` also wires
// these, but an embedder running only the run engine registers them directly.
export { registerExecuteAnalysis } from "./workflows/execute-analysis.js";
export type { ExecuteAnalysisDeps, ExecuteAnalysisInput, ExecuteAnalysisResult, RunProvenanceEvent } from "./workflows/execute-analysis.js";
export { registerSandboxStep } from "./workflows/sandbox-step.js";
export type { SandboxStepDeps, SandboxStepInput, SandboxStepResult, SandboxAgentBuildContext } from "./workflows/sandbox-step.js";

// Sandbox-agent catalog. `buildAgent` maps a `SandboxAgentBuildContext` onto
// `SandboxAgentDeps`, then selects the per-step agent by id from this record;
// `SANDBOX_AGENT_META` is the planner-facing meta the same ids key.
export { createSandboxAgents, SANDBOX_AGENT_META } from "./agents/sandbox/index.js";
export type { SandboxAgentDeps, SandboxStepCoords, AgentMeta } from "./agents/sandbox/index.js";

// Plan schema, structural validation, and per-step prompt rendering — the gates
// a plan passes before it can trigger a run, plus the prompt each step's agent
// receives. `PlanStep` is the minimal `{ id, depends_on }` element type that
// `ExecuteAnalysisInput.steps` is typed against; a parsed `AnalysisPlan`'s
// richer `AnalysisStep[]` is assignable to it.
export { AnalysisPlanSchema } from "./schemas/workflow-state.js";
export type { AnalysisPlan, AnalysisStep } from "./schemas/workflow-state.js";
export type { PlanStep } from "./workflows/execute-analysis-scheduler.js";
export { validatePlan } from "./schemas/validate-plan.js";
export type { ValidatePlanOptions } from "./schemas/validate-plan.js";
export type { ValidationResult } from "./schemas/validate-plan.js";
export { renderStepPrompt } from "./schemas/render-step-prompt.js";

// Plan + run + step ledgers around a trigger. `upsertPlan` takes a
// caller-derived id and inserts-if-absent (the deterministic-id intake path);
// the run-state calls mirror the chat trigger's reserve → dedup → status flow.
export { upsertPlan, loadPlan } from "./state/plans.js";
export type { UpsertPlanInput } from "./state/plans.js";
export { insertRun, queryActiveRun, updateRunStatus, queryRun, queryRunsByAnalysis, RunDedupCollisionError } from "./state/runs.js";
export type { InsertRunInput } from "./state/runs.js";
export { queryStepsByRun } from "./state/step-executions.js";
export type { CortexRunRow, StepExecutionRow, RunStatus } from "./state/schema.js";
// The storage-layer error every `state/` Result fails with. Embedders that
// surface a trigger or ledger failure need it by name to map the `cause`;
// without it they must re-derive it from a function signature.
export type { DbError } from "./lib/db-result.js";
// Backs `WatchdogDeps.queryActiveSandboxes` when the embedder wires the watchdog.
export { queryActiveSandboxes } from "./state/active-sandboxes.js";

// Workspace-tree path convention — the root-relative step directory each
// sandbox step confines its artifact writes to (join onto the resolved root).
export { runStepDir, stepWritePrefix } from "./workspace/paths.js";

// Sandbox-hygiene scheduled workflows. Reaper reclaims a dead host's orphaned
// containers; watchdog converts a dead sandbox into a prompt step failure
// instead of a deadline-long `DBOS.recv` hang; the sweep prunes stale
// notifications. Each is a `@DBOS.scheduled` no-op on an idle system.
export { registerSandboxReaper } from "./sandbox/reaper.js";
export type { RegisterReaperDeps } from "./sandbox/reaper.js";
export { registerWatchdog } from "./sandbox/watchdog.js";
export type { WatchdogDeps } from "./sandbox/watchdog.js";
export { registerNotificationSweep } from "./sandbox/notification-sweep.js";
export type { RegisterNotificationSweepDeps } from "./sandbox/notification-sweep.js";
