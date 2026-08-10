/**
 * `assembleCoreRuntime` — the one host-neutral assembly point.
 *
 * Collapses the two halves of composition into a single call: it registers the
 * durable workflows with the DBOS engine AND builds the conversation agent over
 * the registered callables. Both an embedder's cloud root and the cloud-free
 * root drive the same body, supplying their own seam realizations — the wiring
 * order here is the single source of truth for both.
 *
 * Registration order is load-bearing. The child sandbox-step workflow registers
 * first because the parent's child dispatch closes over its registered callable;
 * `buildExecuteAnalysis` therefore receives that callable rather than a
 * pre-built deps bundle. Every workflow lands under one `launchDbos`
 * `applicationVersion` stamp because all registration happens in this one call,
 * before launch — a blue/green drain treats them as a single cohort.
 */

import { err, ok, type Result } from "neverthrow";

import { createConversationAgent, type ConversationAgentDeps } from "../agents/conversation-agent.js";
import { createReportSessionAgent } from "../agents/report-session-agent.js";
import { createReportSessionRuntime } from "../app/report-session-runtime.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import type { AgentDefinition } from "../loop/types.js";
import type { DomainError } from "../lib/result.js";
import type { ThreadType } from "../memory/thread-store.js";
import { registerExecuteAnalysis, type ExecuteAnalysisDeps, type ExecuteAnalysisInput, type ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { registerSandboxStep, type SandboxStepDeps, type SandboxStepInput, type SandboxStepResult } from "../workflows/sandbox-step.js";
import {
    registerExecuteTargetAssessment,
    type ExecuteTargetAssessmentDeps,
    type ExecuteTargetAssessmentInput,
    type ExecuteTargetAssessmentResult,
} from "../workflows/execute-target-assessment.js";
import { registerDataProfileWorkflow, type DataProfileDeps, type DataProfileWorkflowInput } from "../tasks/data-profile.js";
import { createCitationResolver, type CitationResolverConfig } from "../citations/resolve.js";
import type { CitationResolver } from "../citations/types.js";

/** Registered child sandbox-step callable the parent's child dispatch closes over. */
export type SandboxStepCallable = (input: SandboxStepInput) => Promise<SandboxStepResult>;

/**
 * Deps bundles for the durable workflows. `executeAnalysis` is a builder
 * because its `sandboxStepCallable` is the registered sandbox-step callable,
 * which does not exist until registration runs inside `assembleCoreRuntime`.
 *
 * Each bag omits `usageRecorder` for the same reason `ConversationAssemblyDeps`
 * does: the recorder is resolved once below and stamped onto every bag this
 * call registers, so one runtime reports to one ledger. Leaving it settable
 * here would let an embedder wire a recorder the workflows use and the
 * conversation agent does not — a half-wired ledger that reads as a complete
 * one. The protection has to hold on both sides of the assembly, not just the
 * conversation side.
 */
export interface CoreWorkflowDeps {
    readonly sandboxStep: Omit<SandboxStepDeps, "usageRecorder" | "citationResolver">;
    readonly buildExecuteAnalysis: (sandboxStep: SandboxStepCallable) => Omit<ExecuteAnalysisDeps, "usageRecorder" | "citationResolver">;
    readonly executeTargetAssessment: Omit<ExecuteTargetAssessmentDeps, "usageRecorder">;
    readonly dataProfile: Omit<DataProfileDeps, "usageRecorder">;
}

/** The registered, callable workflow handles. */
export interface RegisteredWorkflows {
    readonly executeAnalysis: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    readonly sandboxStep: SandboxStepCallable;
    readonly executeTargetAssessment: (input: ExecuteTargetAssessmentInput) => Promise<ExecuteTargetAssessmentResult>;
    readonly dataProfile: (input: DataProfileWorkflowInput) => Promise<void>;
}

/**
 * Conversation-agent deps minus the workflow callable, the resource policy, and
 * the usage recorder — `assembleCoreRuntime` supplies those itself so a caller
 * cannot wire a stale callable, a policy that diverges from the one the
 * workflows see, or a recorder that only half the agent tree reports to.
 */
export type ConversationAssemblyDeps = Omit<ConversationAgentDeps, "executeAnalysisWorkflow" | "resourcePolicy" | "usageRecorder" | "citationResolver">;

export interface CoreRuntimeDeps {
    readonly conversation: ConversationAssemblyDeps;
    readonly workflows: CoreWorkflowDeps;
    /**
     * Host resource policy — per-step ceilings and machine budget. One supply
     * point for planner/routing guidance and workflow-input budget snapshots.
     */
    readonly resourcePolicy?: ResourcePolicy;
    /**
     * LLM usage-accounting seam. Resolved once here and stamped onto the
     * conversation agent and every workflow deps bag this call registers, so
     * one runtime reports to one ledger. Omitted falls back to
     * `createNoopUsageRecorder()`.
     */
    readonly usageRecorder?: UsageRecorder;
    /** Harness-owned citation capability configuration; no ambient lookup occurs. */
    readonly citationResolverConfig?: CitationResolverConfig;
}

/**
 * The refusal a thread type carries no agent yet. `report` is a valid
 * `ThreadType` with no registered agent until its builder plugs in at assembly,
 * so resolution has to have a typed way to say "not that one" without throwing.
 * The channel is permanent, not interim: `ThreadType` grows over the product's
 * life, and a bare-`AgentDefinition` return would force every future member to
 * register an agent in the same commit that adds the member.
 */
export interface UnregisteredThreadType {
    readonly type: "unregistered_thread_type";
    readonly threadType: ThreadType;
}

// `UnregisteredThreadType` is a `DomainError` (string `type`) — the compile-time
// check keeps its refusal inside the cross-subsystem error vocabulary.
type _AssertDomainError = UnregisteredThreadType extends DomainError ? true : never;
const _assertDomainError: _AssertDomainError = true;

/**
 * How a thread's type selects the agent that runs its turns. Resolution is a
 * synchronous record lookup, so the channel is plain `Result`, never
 * `ResultAsync`: a registered type resolves to its assembled singleton, an
 * unregistered one refuses on the error channel.
 */
export interface ThreadAgentResolver {
    forThread(type: ThreadType): Result<AgentDefinition, UnregisteredThreadType>;
}

/**
 * Wrap a type→agent registry as the resolution surface. Held apart from
 * `assembleCoreRuntime` so the resolution contract — a registered type resolves
 * to the very object the registry holds, an unregistered one refuses — is
 * exercisable without the DBOS registration `assembleCoreRuntime` performs.
 *
 * The registry holds assembled singletons, so `forThread` returns the same
 * `AgentDefinition` object on every call for a given type: construction-time
 * captures (an embedder's delegating provider handles, closure-wired tools)
 * stay valid across every turn.
 */
export function createThreadAgentResolver(registry: Partial<Record<ThreadType, AgentDefinition>>): ThreadAgentResolver {
    return {
        forThread: (type) => {
            const agent = registry[type];
            if (agent === undefined) {
                const refusal: UnregisteredThreadType = { type: "unregistered_thread_type", threadType: type };
                return err(refusal);
            }
            return ok(agent);
        },
    };
}

export interface CoreRuntime {
    /**
     * Thread→agent resolution — the only way to reach an assembled agent by
     * thread type. Holds the singletons this call built; `conversation` resolves
     * to the assembled conversation agent, every not-yet-registered type refuses
     * on the `Result` channel.
     */
    readonly agents: ThreadAgentResolver;
    readonly workflows: RegisteredWorkflows;
    readonly citationResolver: CitationResolver;
}

export function assembleCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
    const { conversation, workflows: wf, resourcePolicy } = deps;
    const usageRecorder = deps.usageRecorder ?? createNoopUsageRecorder();
    const citationResolver = createCitationResolver({
        ...(deps.citationResolverConfig ?? {}),
        ...(deps.citationResolverConfig?.ncbiApiKey !== undefined || conversation.bioKeys.ncbi === undefined ? {} : { ncbiApiKey: conversation.bioKeys.ncbi }),
        ...(deps.citationResolverConfig?.semanticScholarApiKey !== undefined || conversation.bioKeys.semanticScholar === undefined
            ? {}
            : { semanticScholarApiKey: conversation.bioKeys.semanticScholar }),
    });

    const sandboxStep = registerSandboxStep({ ...wf.sandboxStep, citationResolver, usageRecorder });
    const executeAnalysis = registerExecuteAnalysis({ ...wf.buildExecuteAnalysis(sandboxStep), citationResolver, usageRecorder });
    const executeTargetAssessment = registerExecuteTargetAssessment({ ...wf.executeTargetAssessment, usageRecorder });
    const dataProfile = registerDataProfileWorkflow({ ...wf.dataProfile, usageRecorder });

    const conversationAgent = createConversationAgent({
        ...conversation,
        executeAnalysisWorkflow: executeAnalysis,
        resourcePolicy,
        usageRecorder,
        citationResolver,
    });

    // The report agent is a singleton over the conversation deps. The session
    // runtime binds the per-session state to the thread behind the tool boundary,
    // thus one definition serves every report thread. Its preview tool writes the
    // page into the analysis tree and returns the path, so it reaches no seam.
    const reportSession = createReportSessionRuntime({ pool: conversation.pool, ...(conversation.logger ? { logger: conversation.logger } : {}) });
    const reportAgent = createReportSessionAgent({
        model: conversation.model,
        pool: conversation.pool,
        embedding: conversation.embedding,
        workspaceFs: conversation.workspaceFs,
        gateway: reportSession.gateway,
        resolveWorkspaceRoot: conversation.resolveWorkspaceRoot,
        ...(conversation.logger ? { logger: conversation.logger } : {}),
    });

    // The single registration point for every typed agent. A future thread type's
    // agent plugs in here at assembly with no embedder change. `conversation` is
    // required at the type level because boot resolves it unconditionally
    // (`boot.ts` backfill). `report` is required now that its agent registers here,
    // so a dropped registration fails tsc rather than surfacing only as a
    // resolution refusal. The `Partial` over the rest keeps the compiler honest
    // about a type that has no agent yet.
    const agents: Record<"conversation" | "report", AgentDefinition> & Partial<Record<ThreadType, AgentDefinition>> = {
        conversation: conversationAgent,
        report: reportAgent,
    };

    return {
        agents: createThreadAgentResolver(agents),
        workflows: {
            executeAnalysis,
            sandboxStep,
            executeTargetAssessment,
            dataProfile,
        },
        citationResolver,
    };
}
