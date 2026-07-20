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
    type Logger,
    type Pool,
    type ResolveWorkspaceRoot,
    type RunAuthorizer,
    type SandboxAgentBuildContext,
    type SandboxAgentDeps,
    type SandboxClient,
    type SandboxStepDeps,
    type SandboxStepInput,
    type WorkspaceFilesystem,
} from "@inflexa-ai/harness";

import type { ResolvedHarnessConfig } from "./config.ts";
import type { SwappableSandboxEmitters } from "./prov_bridge.ts";

/**
 * One user-facing agent's chat backend: the {@link ChatProvider} instance
 * bound to that agent's resolved model over the SHARED connection, plus the bare model id. Two agents
 * with the same resolved model share ONE instance (the boot builds one provider per DISTINCT model);
 * two agents with different models carry different instances differing only in the bound wire model.
 */
export type AgentBackend = {
    /** Chat provider bound to `model` (`ChatProvider extends AgentChat`, so it satisfies both seams). */
    readonly provider: ChatProvider;
    /**
     * This agent's RESOLVED model id (config agent override → `harness.model` → connection default),
     * never a config `null`. Kept BARE (it is the id sent on every API call); the provenance identity
     * composes it with {@link RunEngineComposition.modelProvider}.
     */
    readonly model: string;
};

/**
 * The already-constructed backends the run-engine dep bundles draw from. The boot builds each shared
 * instance ONCE — one sandbox client, one workspace filesystem, one embedding-provider instance — and
 * threads them here so the sandbox-step child and the execute-analysis parent close over the SAME
 * backends the data-profile workflow uses. The chat provider is NO LONGER shared: it splits per
 * user-facing agent — the run-engine bundles draw {@link
 * RunEngineComposition.sandbox}; {@link RunEngineComposition.conversation} rides here so boot has one
 * carrier for both agents + the handle. Kept separate from the two per-seam extras
 * (`sandboxStepCallable`, `runAuthorizer`) that only the parent needs.
 */
export type RunEngineComposition = {
    /** App pool over the provisioned Postgres — shared with the harness ledger queries. */
    readonly pool: Pool;
    /**
     * The harness `Logger` seam realized over the cli's pino (see `runtime.ts`).
     * Carried on the composition because the harness's deps accept it OPTIONALLY:
     * a bundle assembled without it type-checks and then discards every
     * diagnostic it makes — including a failed step's only account of its cause.
     */
    readonly logger: Logger;
    /** Real embedding-provider INSTANCE (not the config shape the profile path passes). */
    readonly embedding: EmbeddingProvider;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    /** The workspace-root seam realization (analysis id → `<anchor>/.inflexa/analyses/<slug>`). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** The conversation agent's backend — drives the chat agent and its sub-agents; not read by the run-engine bundles. */
    readonly conversation: AgentBackend;
    /** The sandbox agent's backend — drives the step agents, data profile, ephemeral runner, run synthesis, and post-step metadata. */
    readonly sandbox: AgentBackend;
    /**
     * The vendor slug naming every agent's provider (`anthropic`, `openai`, …) — an open vocabulary,
     * the model connection's CONFIGURED provider fed by boot (one connection across
     * agents), never derived from a model id. A separate FACT beside each agent's `model`, never a
     * combined string, so the composition holds no redundant field to drift; boot composes the
     * `{provider}/{model}` provenance name from this slug and the sandbox agent's model when it builds
     * {@link sandboxEmitters}.
     */
    readonly modelProvider: string;
    /**
     * The sandbox agent's provenance emitters as STABLE delegating handles. The run-engine
     * bundles inject `sandboxEmitters.artifactRegistry` / `sandboxEmitters.emitProvenance` verbatim
     * rather than constructing emitters themselves, so the registered workflows hold ONE identity for
     * the runtime's life. A live sandbox-model switch calls {@link SwappableSandboxEmitters.swap}, which
     * re-points only the cli-owned inner behind these handles — no consumer-held field is mutated, so
     * the swap lands no matter when a consumer reads its deps fields.
     */
    readonly sandboxEmitters: SwappableSandboxEmitters;
    /** Absolute skills tree path — enables the sandbox agents' skill tools. */
    readonly skillsDir: string;
    /**
     * Absolute reference-store path — the same bytes sandboxes mount at `/mnt/refs`.
     * Passed unconditionally: the store may be populated mid-session by a reference
     * download, and the tool re-reads it per call, so a boot-time existence gate here
     * would freeze the cold-start state for the process lifetime.
     */
    readonly refStorePath: string;
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
        provider: comp.sandbox.provider,
        pool: comp.pool,
        sandboxClient: comp.sandboxClient,
        workspaceFs: comp.workspaceFs,
        embedding: comp.embedding,
        lineageCollector: ctx.lineageCollector,
        model: comp.sandbox.model,
        skillsDir: comp.skillsDir,
        refStorePath: comp.refStorePath,
        bioKeys: comp.bioKeys,
        blockerHolder: ctx.blockerHolder,
        step: {
            sandbox: ctx.sandbox,
            workspaceRoot: comp.resolveWorkspaceRoot(ctx.input.analysisId),
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
 * composition's stable delegating artifact registry ({@link
 * RunEngineComposition.sandboxEmitters}) and the catalog-backed `buildAgent` are
 * the only run-specific realizations; everything else is a straight pass-through
 * of the shared backends. `resolveWritePrefix` follows the harness's own path
 * convention (`workspace/paths.ts`) resolved to an ABSOLUTE path under the
 * analysis's workspace root, matching how the profile path builds
 * `allowedWritePrefix`.
 *
 * The injected registry emits `prov.command_executed` / `prov.file_written` /
 * `prov.input_used` events, each stamped with the composed `{provider}/{model}` name (never
 * `prov.step_completed` — that comes from the scheduler settlement via the
 * emitter half of the holder — and never a `cortex_artifacts` write: the harness
 * owns that ledger AROUND the seam, and writes the returned external id back onto
 * its own row), so a registered step's outputs land in the analysis's signed
 * tsprov document. It is the SAME stable object the switch re-points on a live
 * model change, so the registered workflow observes the swap without re-registration.
 */
export function buildSandboxStepDeps(comp: RunEngineComposition): SandboxStepDeps {
    return {
        pool: comp.pool,
        logger: comp.logger,
        provider: comp.sandbox.provider,
        embedding: comp.embedding,
        sandboxClient: comp.sandboxClient,
        artifactRegistry: comp.sandboxEmitters.artifactRegistry,
        workspaceFs: comp.workspaceFs,
        resolveWorkspaceRoot: comp.resolveWorkspaceRoot,
        model: comp.sandbox.model,
        buildAgent: (ctx) => buildStepAgent(comp, ctx),
        resolveWritePrefix: (input: SandboxStepInput) => join(comp.resolveWorkspaceRoot(input.analysisId), runStepDir(input.runId, input.stepId)),
    };
}

/**
 * Assemble the {@link ExecuteAnalysisDeps} the parent workflow registers with.
 * `sandboxStepCallable` MUST be the callable returned by registering the child
 * first (the parent's dispatch closes over it). `synthesisModel` follows the
 * SANDBOX agent (run synthesis is an internal agent that aliases `sandbox`),
 * `runCharge` is the harness no-op bracket, and
 * `synthesisEnabled` is left unset so it defaults to `true` — the skeleton proves
 * the whole body including run-level synthesis.
 *
 * `emitProvenance` is the composition's stable delegating run-lifecycle emitter
 * ({@link RunEngineComposition.sandboxEmitters}), so the run's start/terminal
 * boundaries land as `prov.run_started` / `prov.run_completed` in the signed
 * document — including on a DBOS recovery boot, where body re-execution re-fires
 * it. It is the SAME stable function the switch re-points on a live model change,
 * so the registered parent workflow observes the swap without re-registration.
 */
export function buildExecuteAnalysisDeps(
    comp: RunEngineComposition,
    sandboxStepCallable: ExecuteAnalysisDeps["sandboxStepCallable"],
    runAuthorizer: RunAuthorizer,
): ExecuteAnalysisDeps {
    return {
        pool: comp.pool,
        provider: comp.sandbox.provider,
        embedding: comp.embedding,
        sandboxStepCallable,
        resolveWorkspaceRoot: comp.resolveWorkspaceRoot,
        synthesisModel: comp.sandbox.model,
        bioKeys: comp.bioKeys,
        runCharge: createNoopRunCharge(),
        runAuthorizer,
        emitProvenance: comp.sandboxEmitters.emitProvenance,
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
        provider: comp.sandbox.provider,
        pool: comp.pool,
        sandboxClient: comp.sandboxClient,
        workspaceFs: comp.workspaceFs,
        embedding: comp.embedding,
        resolveWorkspaceRoot: comp.resolveWorkspaceRoot,
        model: comp.sandbox.model,
        bioKeys: comp.bioKeys,
    };
}

/**
 * Assemble the target-assessment workflow's construction deps. Registered
 * deliberately untriggerable in the cli (no surface launches it), so
 * these deps exist only to satisfy `assembleCoreRuntime`'s one-cohort
 * registration — never exercised at runtime. `chatProvider` takes the SANDBOX
 * agent's provider (`ChatProvider extends AgentChat`); `decisionModel`/`synthesisModel`
 * follow the sandbox agent (target assessment is an internal agent aliasing `sandbox`),
 * and `ncbiApiKey` threads the optional NCBI key for the
 * Phase-1 collectors. The return type is sourced from
 * {@link CoreWorkflowDeps} (barrel) rather than the harness-internal
 * `ExecuteTargetAssessmentDeps`, which is not part of the embedder surface.
 */
export function buildExecuteTargetAssessmentDeps(comp: RunEngineComposition, runAuthorizer: RunAuthorizer): CoreWorkflowDeps["executeTargetAssessment"] {
    return {
        pool: comp.pool,
        runAuthorizer,
        ncbiApiKey: comp.bioKeys.ncbi,
        chatProvider: comp.sandbox.provider,
        decisionModel: comp.sandbox.model,
        synthesisModel: comp.sandbox.model,
    };
}
