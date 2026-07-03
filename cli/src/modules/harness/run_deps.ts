import { join } from "node:path";
import {
    createNoopRunCharge,
    createSandboxAgents,
    runStepDir,
    SANDBOX_AGENT_META,
    type AgentDefinition,
    type ArtifactRegistry,
    type ChatProvider,
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
 * The cli-side {@link ArtifactRegistry} — a deliberate no-op stub, not a
 * fake-success shortcut. `register` reports zero registrations and zero
 * failures; `sync` resolves. Two seam-contract facts make this HONEST rather
 * than a lie:
 *
 *  1. The harness's post-step pipeline fails a step ONLY when `failedCount > 0`
 *     (`execution/post-step-pipeline.ts:162-172`). A
 *     `{ registered: [], failed: [], failedCount: 0 }` result merely skips the
 *     external-id write-back and lets the step complete normally.
 *  2. `ArtifactRegistry` implementations MUST NOT touch `cortex_artifacts`
 *     (`execution/artifact-registry.ts:69-71`) — the harness owns that local
 *     ledger write AROUND this seam. So run outputs are still ledgered in
 *     `cortex_artifacts` and land on disk; they simply produce no EXTERNAL,
 *     signed provenance yet.
 *
 * TODO(extend): replace this stub with the bus-adapter provenance bridge —
 * change D (`bridge-harness-provenance`) of the harness-integration change graph
 * (`docs/harness_integration-new/06-change-graph.md`). That adapter translates
 * `register()` into `prov.step_completed` / `prov.file_written` bus events that
 * feed the cli's signed tsprov document. Until it lands, run outputs have no
 * external provenance — only the local ledger and the on-disk artifacts.
 */
export function createStubArtifactRegistry(): ArtifactRegistry {
    return {
        register: async () => ({ registered: [], failed: [], failedCount: 0 }),
        sync: async () => {},
    };
}

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

    const agent = createSandboxAgents(deps)[ctx.input.agentId];
    if (agent === undefined) {
        const known = Object.keys(SANDBOX_AGENT_META).join(", ");
        throw new Error(`unknown sandbox agent id "${ctx.input.agentId}" — known catalog ids: ${known}`);
    }
    return agent;
}

/**
 * Assemble the {@link SandboxStepDeps} the child workflow registers with. The
 * stub registry (above) and the catalog-backed `buildAgent` are the only
 * run-specific realizations; everything else is a straight pass-through of the
 * shared backends. `resolveWritePrefix` follows the harness's own path
 * convention (`workspace/paths.ts:206-211`) resolved to an ABSOLUTE path under
 * the session tree, matching how the profile path builds `allowedWritePrefix`.
 */
export function buildSandboxStepDeps(comp: RunEngineComposition): SandboxStepDeps {
    return {
        pool: comp.pool,
        provider: comp.provider,
        embedding: comp.embedding,
        sandboxClient: comp.sandboxClient,
        artifactRegistry: createStubArtifactRegistry(),
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
 * first (design D1 — the parent's dispatch closes over it). `synthesisModel`
 * reuses the one cli model id (splitting chat vs. synthesis is a later config
 * concern), `runCharge` is the harness no-op bracket, and `synthesisEnabled` is
 * left unset so it defaults to `true` — the skeleton proves the whole body
 * including run-level synthesis (design D6).
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
    };
}
