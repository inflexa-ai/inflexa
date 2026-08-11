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
import { createReportSessionRuntime, type ReportSessionRuntime } from "../app/report-session-runtime.js";
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
import {
    bindExtractionTrigger,
    createExtractionArm,
    registerExtractValuesWorkflow,
    type ExtractValuesResult,
    type ExtractValuesWorkflowInput,
} from "../tasks/extract-values.js";
import { createCitationResolver, type CitationResolverConfig } from "../citations/resolve.js";
import type { CitationResolver } from "../citations/types.js";
import type { AuthContext } from "../auth/types.js";
import { createThreadStore } from "../memory/thread-store.js";
import { createArtifactReadStore, createProductionResolver } from "../report-model/production-resolver.js";
import type { ReferenceResolver } from "../report-model/reference-resolver.js";
import { createReportVersionStore } from "../state/report-versions.js";

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
    readonly extractValues: (input: ExtractValuesWorkflowInput) => Promise<ExtractValuesResult>;
}

/**
 * Conversation-agent deps minus the workflow callable, the resource policy, and
 * the usage recorder — `assembleCoreRuntime` supplies those itself so a caller
 * cannot wire a stale callable, a policy that diverges from the one the
 * workflows see, or a recorder that only half the agent tree reports to.
 */
export type ConversationAssemblyDeps = Omit<ConversationAgentDeps, "executeAnalysisWorkflow" | "resourcePolicy" | "usageRecorder" | "citationResolver">;

/**
 * What binds one reference resolver: the analysis whose pinned artifacts it reads, and the auth of the tool
 * call that reads them. A resolver serves one analysis, thus the report tools build one for each call.
 */
export interface ReportResolverScope {
    readonly analysisId: string;
    readonly auth: AuthContext;
}

/**
 * The factory that gives the reference resolver of one report tool call. The harness wires the production
 * realization, and an embedder can bind its own at its composition root.
 */
export type MakeReportReferenceResolver = (scope: ReportResolverScope) => ReferenceResolver;

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
    /**
     * The byte cap on the in-process host read of a report reference. A file over the
     * cap falls through to the extraction arm. Absent, the resolver uses its 16 MiB
     * default. The embedder tunes it here, thus a host changes it with no harness change.
     */
    readonly reportHostReadCapBytes?: number;
    /**
     * The report reference resolver of an embedder. A managed host reads its pinned
     * artifacts from its own store, thus it binds a realization of the seam here and the
     * report tools resolve through it. Absent, the harness wires the production resolver
     * over the workspace tree and the extraction arm, which is the whole OSS path. A bound
     * factory replaces that wiring, thus `reportHostReadCapBytes` then governs nothing.
     */
    readonly makeReportReferenceResolver?: MakeReportReferenceResolver;
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
    /**
     * The turn-start anchor of a report session. A serving path runs it at the
     * turn start, thus a report tool call never arrives before the session state
     * exists. The gateway stays behind the tool boundary, thus the runtime exposes
     * the anchor operation alone here, and a later change wires it at the turn start.
     */
    readonly reportSession: Pick<ReportSessionRuntime, "ensureSessionState">;
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
    // The extraction workflow shares the profile's sandbox and authorization rails, thus it draws the same
    // three seams from the profile deps. The report resolver factory binds the extraction arm over this
    // callable, thus a fall-through report reference reads its file out of process on the profile rails.
    const extractValues = registerExtractValuesWorkflow({
        sandboxClient: wf.dataProfile.sandboxClient,
        runAuthorizer: wf.dataProfile.runAuthorizer,
        ...(wf.dataProfile.logger ? { logger: wf.dataProfile.logger } : {}),
    });

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
    // page into the analysis tree and returns the path, thus the page write reaches
    // no host seam.
    const reportSession = createReportSessionRuntime({ pool: conversation.pool, ...(conversation.logger ? { logger: conversation.logger } : {}) });
    const reportVersionStore = createReportVersionStore({ pool: conversation.pool, ...(conversation.logger ? { logger: conversation.logger } : {}) });
    const reportThreads = createThreadStore(conversation.pool);

    // The read cache of the production report path, one for each recent analysis. A preview
    // and the record that follows it are two tool calls over one draft, thus they meet the
    // same artifacts. The store carries the streamed hash and the extracted rows between
    // them, and each resolver still binds its own extraction arm below. Thus the auth of a
    // call never outlives the call, and one unchanged file costs one hash and one container.
    const reportArtifactReads = createArtifactReadStore();

    // The reference resolver of the report path, and its production wiring. A resolver reads
    // the pinned artifacts of one analysis, thus the factory binds one analysis and one auth
    // for each tool call. The extraction arm falls through to the registered extract-values
    // callable for an over-cap file or a host parse fault. The cap gates the host read, and
    // the resolver defaults it to 16 MiB.
    const makeProductionReportResolver = (scope: ReportResolverScope): ReferenceResolver => {
        const arm = createExtractionArm(
            bindExtractionTrigger({ runAuthorizer: conversation.runAuthorizer, workflow: extractValues }, { auth: scope.auth, analysisId: scope.analysisId }),
        );
        return createProductionResolver({
            workspaceRoot: conversation.resolveWorkspaceRoot(scope.analysisId),
            analysisId: scope.analysisId,
            extractionArm: arm,
            readCache: reportArtifactReads.forAnalysis(scope.analysisId),
            ...(deps.reportHostReadCapBytes !== undefined ? { cap: deps.reportHostReadCapBytes } : {}),
        });
    };
    const makeReportResolver = deps.makeReportReferenceResolver ?? makeProductionReportResolver;

    const reportAgent = createReportSessionAgent({
        model: conversation.model,
        pool: conversation.pool,
        embedding: conversation.embedding,
        workspaceFs: conversation.workspaceFs,
        gateway: reportSession.gateway,
        resolveWorkspaceRoot: conversation.resolveWorkspaceRoot,
        store: reportVersionStore,
        threads: reportThreads,
        chrome: conversation.chrome,
        makeResolver: makeReportResolver,
        ...(conversation.logger ? { logger: conversation.logger } : {}),
    });

    // The single registration point for every typed agent. A future thread type's
    // agent plugs in here at assembly with no embedder change. `conversation` is
    // required at the type level because boot resolves it unconditionally
    // (`boot.ts` backfill). `report` is required now that its agent registers here,
    // so a dropped registration fails tsc, and it does not surface only as a
    // resolution refusal. The `Partial` over the rest keeps the compiler honest
    // about a type that has no agent yet.
    const agents: Record<"conversation" | "report", AgentDefinition> & Partial<Record<ThreadType, AgentDefinition>> = {
        conversation: conversationAgent,
        report: reportAgent,
    };

    return {
        agents: createThreadAgentResolver(agents),
        reportSession: { ensureSessionState: reportSession.ensureSessionState },
        workflows: {
            executeAnalysis,
            sandboxStep,
            executeTargetAssessment,
            dataProfile,
            extractValues,
        },
        citationResolver,
    };
}
