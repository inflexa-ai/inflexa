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
import { registerEphemeralWorkflow, type EphemeralDeps, type EphemeralResult, type EphemeralWorkflowInput } from "../execution/ephemeral-runner.js";

/** Registered child sandbox-step callable the parent's child dispatch closes over. */
export type SandboxStepCallable = (input: SandboxStepInput) => Promise<SandboxStepResult>;

/**
 * Deps bundles for the five durable workflows. `executeAnalysis` is a builder
 * because its `sandboxStepCallable` is the registered sandbox-step callable,
 * which does not exist until registration runs inside `assembleCoreRuntime`.
 */
export interface CoreWorkflowDeps {
    readonly sandboxStep: SandboxStepDeps;
    readonly buildExecuteAnalysis: (sandboxStep: SandboxStepCallable) => ExecuteAnalysisDeps;
    readonly executeTargetAssessment: ExecuteTargetAssessmentDeps;
    readonly dataProfile: DataProfileDeps;
    readonly ephemeral: EphemeralDeps;
}

/** The registered, callable workflow handles. */
export interface RegisteredWorkflows {
    readonly executeAnalysis: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    readonly sandboxStep: SandboxStepCallable;
    readonly executeTargetAssessment: (input: ExecuteTargetAssessmentInput) => Promise<ExecuteTargetAssessmentResult>;
    readonly dataProfile: (input: DataProfileWorkflowInput) => Promise<void>;
    readonly ephemeral: (input: EphemeralWorkflowInput) => Promise<EphemeralResult>;
}

/**
 * Conversation-agent deps minus the two workflow callables — `assembleCoreRuntime`
 * supplies those from its own registration so a caller cannot wire a stale one.
 */
export type ConversationAssemblyDeps = Omit<ConversationAgentDeps, "executeAnalysisWorkflow" | "ephemeralWorkflow">;

export interface CoreRuntimeDeps {
    readonly conversation: ConversationAssemblyDeps;
    readonly workflows: CoreWorkflowDeps;
}

export interface CoreRuntime {
    readonly conversationAgent: AgentDefinition;
    readonly workflows: RegisteredWorkflows;
}

export function assembleCoreRuntime(deps: CoreRuntimeDeps): CoreRuntime {
    const { conversation, workflows: wf } = deps;

    const sandboxStep = registerSandboxStep(wf.sandboxStep);
    const executeAnalysis = registerExecuteAnalysis(wf.buildExecuteAnalysis(sandboxStep));
    const executeTargetAssessment = registerExecuteTargetAssessment(wf.executeTargetAssessment);
    const dataProfile = registerDataProfileWorkflow(wf.dataProfile);
    const ephemeral = registerEphemeralWorkflow(wf.ephemeral);

    const conversationAgent = createConversationAgent({
        ...conversation,
        executeAnalysisWorkflow: executeAnalysis,
        ephemeralWorkflow: ephemeral,
    });

    return {
        conversationAgent,
        workflows: {
            executeAnalysis,
            sandboxStep,
            executeTargetAssessment,
            dataProfile,
            ephemeral,
        },
    };
}
