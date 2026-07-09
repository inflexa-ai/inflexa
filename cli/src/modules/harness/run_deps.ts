import { join } from "node:path";
import {
    createNoopRunCharge,
    createSandboxAgents,
    runStepDir,
    SANDBOX_AGENT_META,
    type AgentDefinition,
    type ChatProvider,
    type CoreWorkflowDeps,
    type EmbeddingProvider,
    type ExecuteAnalysisDeps,
    type Pool,
    type RunAuthorizer,
    type SandboxAgentBuildContext,
    type SandboxAgentDeps,
    type SandboxClient,
    type SandboxStepDeps,
    type SandboxStepInput,
    type WorkspaceFilesystem,
} from "@inflexa-ai/harness";

import type { ResolvedHarnessConfig } from "./config.ts";
import { createBusArtifactRegistry, createRunProvenanceEmitter } from "./prov_bridge.ts";

/**
 * The already-constructed backends both run-engine dep bundles draw from. The
 * boot builds each instance ONCE — one chat provider, one sandbox client, one
 * workspace filesystem, one embedding-provider instance — and threads them here
 * so the sandbox-step child and the execute-analysis parent close over the SAME
 * backends the data-profile workflow uses. Kept separate from the two per-seam
 * extras (`sandboxStepCallable`, `runAuthorizer`) that only the parent needs, so
 * this shape is exactly "the shared graph" and nothing more.
 */
export type RunEngineComposition = {
    /** App pool over the provisioned Postgres — shared with the harness ledger queries. */
    readonly pool: Pool;
    /** Proxy-backed chat provider (`ChatProvider extends AgentChat`, so it satisfies both seams). */
    readonly provider: ChatProvider;
    /** Real embedding-provider INSTANCE (not the config shape the profile path passes). */
    readonly embedding: EmbeddingProvider;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    /** Base path holding per-analysis session directories. */
    readonly sessionsBasePath: string;
    /** Chat/sandbox model id — also the synthesis model (one config id today; D6). */
    readonly model: string;
    /** Absolute skills tree path — enables the sandbox agents' skill tools. */
    readonly skillsDir: string;
    /** Bio/chem API keys; absent keys pass as empty strings and surface per-call. */
    readonly bioKeys: ResolvedHarnessConfig["bioKeys"];
};

/**
 * Resolve the step's agent from the harness sandbox catalog, wiring its deps
 * from the composition-level backends plus this step's per-call context. The
 * two are threaded exactly as the harness's own data-profile agent construction
 * does (`tasks/data-profile.ts:207-235`): composition backends on the flat
 * fields, per-step coordinates under `step`.
 *
 * An agent id absent from the catalog throws. `throw` is correct here despite
 * the cli's neverthrow-first default: `buildAgent` runs inside the harness
 * workflow body where an exception IS the step's failure channel (the seam
 * returns `AgentDefinition`, not a `Result`), and `validatePlan` already rejects
 * unknown agent ids upstream — so this is defense-in-depth on a path the plan
 * gate makes unreachable, and the message names the id and the known catalog ids
 * for the operator who somehow reaches it.
 */
function buildStepAgent(comp: RunEngineComposition, ctx: SandboxAgentBuildContext): AgentDefinition {
    const deps: SandboxAgentDeps = {
        provider: comp.provider,
        pool: comp.pool,
        sandboxClient: comp.sandboxClient,
        workspaceFs: comp.workspaceFs,
        embedding: comp.embedding,
        lineageCollector: ctx.lineageCollector,
        model: comp.model,
        skillsDir: comp.skillsDir,
        bioKeys: comp.bioKeys,
        blockerHolder: ctx.blockerHolder,
        step: {
            sandbox: ctx.sandbox,
            sessionsBasePath: comp.sessionsBasePath,
            analysisId: ctx.input.analysisId,
            runId: ctx.input.runId,
            stepId: ctx.input.stepId,
            workflowId: ctx.workflowId,
            allowedWritePrefix: ctx.stepWritePrefix,
            nextFunctionId: ctx.nextFunctionId,
            deadlineMs: ctx.deadlineMs,
        },
    };

    // TODO(perf): `createSandboxAgents` builds the entire ~22-agent catalog
    // (prompt composition + per-tool `z.toJSONSchema()` wiring) and we keep one,
    // per step and again on every workflow replay. The cost is in-memory CPU with
    // no I/O against a multi-minute sandboxed step, so it is acceptable today; the
    // real fix is a harness-side per-id selector (e.g. `createSandboxAgent(deps,
    // id)`) since the deps are per-`ctx` and cannot be hoisted to boot. Mirrors the
    // harness's own data-profile construction, which selects the same way.
    // Tracked in https://github.com/inflexa-ai/inf-cli/issues/30.
    const agent = createSandboxAgents(deps)[ctx.input.agentId];
    if (agent === undefined) {
        const known = Object.keys(SANDBOX_AGENT_META).join(", ");
        throw new Error(`unknown sandbox agent id "${ctx.input.agentId}" — known catalog ids: ${known}`);
    }
    return agent;
}

/**
 * Assemble the {@link SandboxStepDeps} the child workflow registers with. The
 * bus-adapter registry ({@link createBusArtifactRegistry}) and the catalog-backed
 * `buildAgent` are the only run-specific realizations; everything else is a
 * straight pass-through of the shared backends. `resolveWritePrefix` follows the
 * harness's own path convention (`workspace/paths.ts:206-211`) resolved to an
 * ABSOLUTE path under the session tree, matching how the profile path builds
 * `allowedWritePrefix`.
 *
 * The registry realization emits `prov.step_completed` / `prov.file_written`
 * events (never writes `cortex_artifacts` — the harness owns that ledger AROUND
 * the seam, and writes the returned external id back onto its own row), so a
 * registered step's outputs land in the analysis's signed tsprov document.
 */
export function buildSandboxStepDeps(comp: RunEngineComposition): SandboxStepDeps {
    return {
        pool: comp.pool,
        provider: comp.provider,
        embedding: comp.embedding,
        sandboxClient: comp.sandboxClient,
        artifactRegistry: createBusArtifactRegistry(),
        workspaceFs: comp.workspaceFs,
        sessionsBasePath: comp.sessionsBasePath,
        model: comp.model,
        buildAgent: (ctx) => buildStepAgent(comp, ctx),
        resolveWritePrefix: (input: SandboxStepInput) => join(comp.sessionsBasePath, runStepDir(input.analysisId, input.runId, input.stepId)),
    };
}

/**
 * Assemble the {@link ExecuteAnalysisDeps} the parent workflow registers with.
 * `sandboxStepCallable` MUST be the callable returned by registering the child
 * first (the parent's dispatch closes over it). `synthesisModel`
 * reuses the one cli model id (splitting chat vs. synthesis is a later config
 * concern), `runCharge` is the harness no-op bracket, and `synthesisEnabled` is
 * left unset so it defaults to `true` — the skeleton proves the whole body
 * including run-level synthesis.
 *
 * `emitProvenance` realizes the harness's optional run-lifecycle observer as bus
 * emission ({@link createRunProvenanceEmitter}), so the run's start/terminal
 * boundaries land as `prov.run_started` / `prov.run_completed` in the signed
 * document — including on a DBOS recovery boot, where body re-execution re-fires it.
 */
export function buildExecuteAnalysisDeps(
    comp: RunEngineComposition,
    sandboxStepCallable: ExecuteAnalysisDeps["sandboxStepCallable"],
    runAuthorizer: RunAuthorizer,
): ExecuteAnalysisDeps {
    return {
        pool: comp.pool,
        provider: comp.provider,
        embedding: comp.embedding,
        sandboxStepCallable,
        sessionsBasePath: comp.sessionsBasePath,
        synthesisModel: comp.model,
        bioKeys: comp.bioKeys,
        runCharge: createNoopRunCharge(),
        runAuthorizer,
        emitProvenance: createRunProvenanceEmitter(),
    };
}

/**
 * Assemble the ephemeral-runner's construction deps. Every field is a straight
 * pass-through of the shared backends — an ephemeral chat-turn run needs the same
 * provider/pool/sandbox/workspace/embedding graph the durable workflows use.
 * `resourcePolicy` is omitted deliberately: `assembleCoreRuntime` injects the one
 * host policy so the ephemeral sandbox size can never diverge from what the
 * planner tools and `execute_plan` see. The return type is sourced from
 * {@link CoreWorkflowDeps} (barrel) rather than the harness-internal `EphemeralDeps`,
 * which is not part of the embedder surface.
 */
export function buildEphemeralDeps(comp: RunEngineComposition): CoreWorkflowDeps["ephemeral"] {
    return {
        provider: comp.provider,
        pool: comp.pool,
        sandboxClient: comp.sandboxClient,
        workspaceFs: comp.workspaceFs,
        embedding: comp.embedding,
        sessionsBasePath: comp.sessionsBasePath,
        model: comp.model,
        bioKeys: comp.bioKeys,
    };
}

/**
 * Assemble the target-assessment workflow's construction deps. Registered
 * deliberately untriggerable in the cli (no surface launches it), so
 * these deps exist only to satisfy `assembleCoreRuntime`'s one-cohort
 * registration — never exercised at runtime. `chatProvider` takes the one shared
 * provider (`ChatProvider extends AgentChat`); `decisionModel`/`synthesisModel`
 * reuse the single cli model id, and `ncbiApiKey` threads the optional NCBI key
 * for the Phase-1 collectors. The return type is sourced from
 * {@link CoreWorkflowDeps} (barrel) rather than the harness-internal
 * `ExecuteTargetAssessmentDeps`, which is not part of the embedder surface.
 */
export function buildExecuteTargetAssessmentDeps(comp: RunEngineComposition, runAuthorizer: RunAuthorizer): CoreWorkflowDeps["executeTargetAssessment"] {
    return {
        pool: comp.pool,
        runAuthorizer,
        ncbiApiKey: comp.bioKeys.ncbi,
        chatProvider: comp.provider,
        decisionModel: comp.model,
        synthesisModel: comp.model,
    };
}
