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
export { createFilesystemArtifactRegistry } from "./execution/filesystem-artifact-registry.js";
export type { FilesystemArtifactRegistryDeps } from "./execution/filesystem-artifact-registry.js";
export type { ArtifactRegistry, ArtifactRegistrationInput, ExternalRegistrationResult } from "./execution/artifact-registry.js";

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
export type { ChatProvider, EmbeddingProvider, ChatRequest, ChatResponse, ChatStreamEvent, ModelMessage } from "./providers/types.js";

// Embedder runtime surface — what a same-process host needs to run durable
// workflows itself: the DBOS lifecycle, per-workflow registration + triggers,
// the staged-input manifest contract, the sandbox/workspace factories over its
// session tree, and the exec-callback envelope pieces (the HTTP→DBOS-topic
// ingress is the embedder's to host; see the sandbox-server callback protocol).

// DBOS lifecycle.
export { launchDbos, shutdownDbos } from "./runtime/dbos.js";
export type { DbosConfig } from "./runtime/dbos.js";

// Application pool. Exported so an embedder never declares its own `pg`
// dependency: the pool it hands to workflow deps is built by the same pg
// copy the harness queries with.
export { createPool } from "./lib/storage.js";
export type { PoolConfig } from "./lib/storage.js";
export type { Pool } from "pg";

// Data-profile workflow: registration + trigger. `triggerDataProfile` claims
// pending/completed rows only; a failed profile is re-claimed via
// `tryRetryDataProfile` and then started with `runDataProfile` (the managed
// retry route's shape — embedders mirror it).
export { registerDataProfileWorkflow, triggerDataProfile, runDataProfile } from "./tasks/data-profile.js";
export type { DataProfileDeps, DataProfileWorkflowInput, DataProfileTriggerDeps, DataProfileTriggerParams, DataProfileTriggerResult } from "./tasks/data-profile.js";

// Ledger surface the embedder needs around a trigger: schema init at boot,
// the analysis-state seed (the trigger's CAS transitions the row this creates
// — without it every trigger reports "failed"), and run-state observation.
export { initCortexState } from "./state/init.js";
export { upsertAnalysis } from "./state/analyses.js";
export { loadDataProfileStatus, tryRetryDataProfile } from "./state/data-profile.js";
export type { DataProfileStatus } from "./state/data-profile.js";

// Staged-input manifest contract (the embedder stages; the harness only reads).
export type { StagedInput } from "./execution/staged-input.js";

// Sandbox + workspace seams over the embedder's session tree.
export { createSandboxClient } from "./sandbox/create-sandbox.js";
export type { CreateSandboxClientConfig, SandboxBackendConfig } from "./sandbox/create-sandbox.js";
export type { SandboxClient } from "./sandbox/client.js";
export { ResourceLimitsSchema } from "./config/resource-limits.js";
export type { ResourceLimits } from "./config/resource-limits.js";
export { createWorkspaceFilesystem } from "./workspace/filesystem.js";
export type { WorkspaceFilesystem, WorkspaceFilesystemDeps } from "./workspace/filesystem.js";

// Exec-callback ingress building blocks. Delivery goes through
// `deliverExecEvent` — never a host-side `DBOS.send`: the SDK is
// module-singleton state, and a host's own copy would be un-launched.
export { workflowIdFromExec } from "./sandbox/exec-id.js";
export { deliverExecEvent, execEventTopic } from "./sandbox/deliver-exec-event.js";
export { ExecEventMessageSchema } from "./sandbox/types.js";
export type { ExecEventMessage, DoneMarker } from "./sandbox/types.js";
