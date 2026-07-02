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
