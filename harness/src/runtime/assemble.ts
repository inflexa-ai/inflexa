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

import { createConversationAgent, type ConversationAgentDeps } from "../agents/conversation-agent.js";
import { createNoopUsageRecorder } from "../billing/noop-usage-recorder.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import type { AgentDefinition } from "../loop/types.js";
import { registerExecuteAnalysis, type ExecuteAnalysisDeps, type ExecuteAnalysisInput, type ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import { registerSandboxStep, type SandboxStepDeps, type SandboxStepInput, type SandboxStepResult } from "../workflows/sandbox-step.js";
import {
    registerExecuteTargetAssessment,
    type ExecuteTargetAssessmentDeps,
    type ExecuteTargetAssessmentInput,
    type ExecuteTargetAssessmentResult,
} from "../workflows/execute-target-assessment.js";
import { registerDataProfileWorkflow, type DataProfileDeps, type DataProfileWorkflowInput } from "../tasks/data-profile.js";

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
    readonly sandboxStep: Omit<SandboxStepDeps, "usageRecorder">;
    readonly buildExecuteAnalysis: (sandboxStep: SandboxStepCallable) => Omit<ExecuteAnalysisDeps, "usageRecorder">;
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
export type ConversationAssemblyDeps = Omit<ConversationAgentDeps, "executeAnalysisWorkflow" | "resourcePolicy" | "usageRecorder">;

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
}

export interface CoreRuntime {
    readonly conversationAgent: AgentDefinition;
    readonly workflows: RegisteredWorkflows;
}

export function assembleCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
    const { conversation, workflows: wf, resourcePolicy } = deps;
    const usageRecorder = deps.usageRecorder ?? createNoopUsageRecorder();

    const sandboxStep = registerSandboxStep({ ...wf.sandboxStep, usageRecorder });
    const executeAnalysis = registerExecuteAnalysis({ ...wf.buildExecuteAnalysis(sandboxStep), usageRecorder });
    const executeTargetAssessment = registerExecuteTargetAssessment({ ...wf.executeTargetAssessment, usageRecorder });
    const dataProfile = registerDataProfileWorkflow({ ...wf.dataProfile, usageRecorder });

    const conversationAgent = createConversationAgent({
        ...conversation,
        executeAnalysisWorkflow: executeAnalysis,
        resourcePolicy,
        usageRecorder,
    });

    return {
        conversationAgent,
        workflows: {
            executeAnalysis,
            sandboxStep,
            executeTargetAssessment,
            dataProfile,
        },
    };
}
