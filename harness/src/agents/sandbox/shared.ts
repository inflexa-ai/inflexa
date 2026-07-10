/**
 * Sandbox-agent composition root.
 *
 * `createSandboxAgent(deps, meta, body, opts?)` produces a fully dep-bound
 * `AgentDefinition` for one sandbox agent (see the harness-durable-runtime spec): SOUL kernel + the
 * agent's own prompt body + sandbox standards composed into a single
 * static `systemPrompt` string (no processors at request time, see the harness-providers spec),
 * the workspace mutate trio (`execute_command`, `write_file`, `edit_file`)
 * bound to the shared `SandboxClient` and the step's `allowedWritePrefix`,
 * the workspace read tools (`read_file`, `grep`) over the shared
 * `WorkspaceFilesystem`, and the bio/literature/context7/run-inspection
 * tools its `meta.tools` allowlist names.
 *
 * Tool resolution is a single registry lookup — every name in `meta.tools`
 * must map to a concrete `Tool`; unknown names throw at composition time
 * so misconfigured agents fail at startup, not at the first LLM call.
 */

import type { Pool } from "pg";

import type { AgentDefinition } from "../../loop/types.js";
import type { ChatProvider, EmbeddingProvider } from "../../providers/types.js";
import type { SandboxClient } from "../../sandbox/client.js";
import type { SandboxRef } from "../../sandbox/types.js";
import type { Tool } from "../../tools/define-tool.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { ProvenanceCollector as LineageCollector } from "../../provenance/collector.js";

import { sandboxOrientCorePrompt, sandboxAnalysisStepStandardsPrompt } from "../../prompts/sandbox-standards.js";
import { composeSystemPrompt } from "../system-prompt.js";

// Sandbox-environment introspection.
import { listAvailablePackagesTool, listAvailableRefsTool } from "../../tools/sandbox/index.js";

// Context7 docs (pure leaves).
import { queryDocsTool, resolveLibraryIdTool } from "../../tools/research/context7-docs.js";

// Run-inspection (dependency-bearing).
import { createInspectRunTool } from "../../tools/research/inspect-run.js";

// Bio leaf tools.
import {
    checkSafetyPanelTool,
    getBioactivityTool,
    getDrugInfoTool,
    getImpcKoProfileTool,
    getMechanismTool,
    getPubchemAssaysTool,
    getPubchemCrossRefsTool,
    getTargetSafetyTool,
    lookupGoTermTool,
    searchBgeeExpressionTool,
    searchClinicalTrialsTool,
    searchCompoundsTool,
    searchDgidbTool,
    searchFaersTool,
    searchGeneTool,
    searchGeoDatasetsTool,
    searchGwasCatalogTool,
    searchInteractionsTool,
    searchOpenTargetsTool,
    searchPathwayTool,
    searchPharmgkbTool,
    searchPubchemCompoundTool,
    searchTargetsTool,
} from "../../tools/bio/index.js";
import { createNcbiTools, createChemDbTools, type BioToolKeys } from "../../tools/bio/keys.js";

// Workspace read surface.
import { createFileStatTool, createGrepTool, createListFilesTool, createReadFileTool, createWorkspaceSearchTool } from "../../tools/workspace/index.js";

// Workspace mutate surface.
import { createEditFileTool, createExecuteCommandTool, createWorkspaceMutator, createWriteFileTool } from "../../tools/workspace/index.js";

// Skills (declared per agent via meta.skills).
import { createSkillTools } from "../../tools/sandbox/skills.js";

import { createReportBlockerTool, type BlockerHolder } from "../../tools/sandbox/report-blocker.js";

import { toSandboxPath } from "../../workspace/paths.js";
import { setActiveExecId } from "../../state/index.js";

import type { AgentMeta, SandboxToolName } from "./types.js";
import { SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS } from "./types.js";

/**
 * Tools every sandbox agent receives — sandbox-environment introspection,
 * library docs, and run inspection. Spread into each agent's
 * `meta.tools` so planner-facing metadata and the resolved tool record
 * stay in sync. Keep minimal — only tools every agent genuinely needs.
 */
export const BASE_SANDBOX_TOOLS: readonly SandboxToolName[] = ["listAvailablePackages", "listAvailableRefs", "resolveLibraryId", "queryDocs", "inspectRun"];

/** Per-step coordinates the composition root threads through every mutate tool. */
export interface SandboxStepCoords {
    readonly sandbox: SandboxRef;
    /** Absolute host root of this analysis's workspace tree (resolved at the workflow body). */
    readonly workspaceRoot: string;
    readonly analysisId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly workflowId: string;
    /** Absolute writable artifact directory for this step (e.g. stepWritePrefix(...)). */
    readonly allowedWritePrefix: string;
    /** Stable per-call function id minter (monotonic; replay-deterministic). */
    readonly nextFunctionId: () => string;
    /** Absolute unix-ms deadline for `awaitExec`. */
    readonly deadlineMs: () => number;
}

/** The shared dependency graph every sandbox agent draws from. */
export interface SandboxAgentDeps {
    readonly provider: ChatProvider;
    readonly pool: Pool;
    readonly sandboxClient: SandboxClient;
    readonly workspaceFs: WorkspaceFilesystem;
    /** Embedding provider for in-sandbox semantic `workspace_search`. Omit to skip that tool. */
    readonly embedding?: EmbeddingProvider;
    /**
     * Step-scoped lineage collector fed by each `execute_command`'s
     * `ExecResult.provenance` frame. Records the input/script edges post-step
     * registration translates into provenance parents.
     */
    readonly lineageCollector?: LineageCollector;
    /** Model id provenance label — the provider owns the wire model. */
    readonly model: string;
    /** Absolute path to the skills tree. Omit to skip the skill tools. */
    readonly skillsDir?: string;
    /** Per-step coordinates resolved at the workflow body. */
    readonly step: SandboxStepCoords;
    /** API keys for the external bio/chem data sources. */
    readonly bioKeys: BioToolKeys;
    /**
     * Per-run blocker cell (see the harness-sandbox-agents spec). When present, the agent gets a
     * `report_blocker` tool that records `{ kind: "blocker", reason }` into it;
     * the sandbox-step body reads `holder.outcome` after the loop. Omit for
     * agents that have no terminal status to declare (ephemeral, data profiler).
     */
    readonly blockerHolder?: BlockerHolder;
}

/** Per-agent override for the prompt composition and tool surface. */
export interface SandboxAgentPromptOptions {
    /** Append `sandboxAnalysisStepStandardsPrompt`. Defaults to true. */
    readonly appendAnalysisStepStandards?: boolean;
    /**
     * Enforced read-only: omit `write_file` + `edit_file` from the workspace
     * surface. `execute_command` and all read tools stay. Pair with a sandbox
     * provisioned with no read-write mount (ephemeral) so no writable location
     * exists outside container-local `/tmp`. Defaults to false.
     */
    readonly readOnly?: boolean;
}

/**
 * Resolve `meta.tools` into the bio/research tools record. Workspace
 * read/mutate tools are added by `createSandboxAgent` regardless of meta
 * — they are the always-on substrate, not in the allowlist.
 */
function resolveSandboxTools(deps: SandboxAgentDeps, tools: readonly SandboxToolName[]): Tool[] {
    const ncbi = createNcbiTools(deps.bioKeys);
    const chemDb = createChemDbTools(deps.bioKeys);
    const registry: Record<SandboxToolName, Tool> = {
        listAvailablePackages: listAvailablePackagesTool,
        listAvailableRefs: listAvailableRefsTool,
        resolveLibraryId: resolveLibraryIdTool,
        queryDocs: queryDocsTool,
        inspectRun: createInspectRunTool(deps.pool),
        searchPubMed: ncbi.searchPubMed,
        getArticleDetails: ncbi.getArticleDetails,
        getArticleFullText: ncbi.getArticleFullText,
        searchGene: searchGeneTool,
        searchPathway: searchPathwayTool,
        lookupGoTerm: lookupGoTermTool,
        searchInteractions: searchInteractionsTool,
        searchCompounds: searchCompoundsTool,
        getBioactivity: getBioactivityTool,
        searchTargets: searchTargetsTool,
        getMechanism: getMechanismTool,
        getDrugInfo: getDrugInfoTool,
        searchPubchemCompound: searchPubchemCompoundTool,
        getPubchemCrossRefs: getPubchemCrossRefsTool,
        getPubchemAssays: getPubchemAssaysTool,
        searchOpenTargets: searchOpenTargetsTool,
        getTargetSafety: getTargetSafetyTool,
        searchPharmgkb: searchPharmgkbTool,
        searchFaers: searchFaersTool,
        searchClinicalTrials: searchClinicalTrialsTool,
        searchGeoDatasets: searchGeoDatasetsTool,
        searchClinvar: ncbi.searchClinvar,
        searchDgidb: searchDgidbTool,
        searchGwasCatalog: searchGwasCatalogTool,
        searchDisgenet: chemDb.searchDisgenet,
        searchDrugbank: chemDb.searchDrugbank,
        searchBgeeExpression: searchBgeeExpressionTool,
        getImpcKoProfile: getImpcKoProfileTool,
        checkSafetyPanel: checkSafetyPanelTool,
        searchToxcast: chemDb.searchToxcast,
        searchCtxHazard: chemDb.searchCtxHazard,
        searchCtxChemical: chemDb.searchCtxChemical,
        searchCtxExposure: chemDb.searchCtxExposure,
    };

    const seen = new Set<SandboxToolName>();
    const resolved: Tool[] = [];
    for (const name of tools) {
        if (seen.has(name)) continue;
        seen.add(name);
        const tool = registry[name];
        if (!tool) {
            throw new Error(`createSandboxAgent: unknown SandboxToolName "${name}" — ` + `agent meta references a tool with no harness implementation.`);
        }
        resolved.push(tool);
    }
    return resolved;
}

/** Build the workspace mutate + read tools every sandbox agent receives. In
 *  `readOnly` mode the write_file/edit_file pair is omitted; execute_command
 *  and the read tools stay. */
function buildWorkspaceTools(deps: SandboxAgentDeps, readOnly: boolean): Tool[] {
    const { step, sandboxClient, workspaceFs, pool, embedding, lineageCollector } = deps;
    // Registry tagging is a best-effort watchdog backstop (`run-exec.ts` already
    // swallows a throw here); fold a `DbError` into a no-op so a registry write
    // failure neither fails the exec nor surfaces as an unhandled rejection.
    const markExecActive = (execId: string): Promise<void> =>
        setActiveExecId(pool, step.runId, step.stepId, execId).match(
            () => {},
            () => {},
        );

    // The agent's writable working directory: relative paths resolve here, and
    // writes are confined here. `allowedWritePrefix` is its host path; the
    // in-sandbox path (the `execute_command` default cwd, see the harness-workspace-tools spec) is the same
    // location under the `/{analysisId}` mount — derived from the host path so
    // it is correct for non-step agents (data profiler, ephemeral) too.
    const hostWorkingDir = step.allowedWritePrefix;
    const sandboxWorkingDir = toSandboxPath(step.workspaceRoot, step.analysisId, hostWorkingDir);

    const mutateTools = readOnly
        ? []
        : (() => {
              const mutator = createWorkspaceMutator({
                  sandboxClient,
                  sandbox: step.sandbox,
                  workspaceRoot: step.workspaceRoot,
                  analysisId: step.analysisId,
                  stepId: step.stepId,
                  workflowId: step.workflowId,
                  workingDir: hostWorkingDir,
                  sandboxWorkingDir,
                  nextFunctionId: step.nextFunctionId,
                  deadlineMs: step.deadlineMs,
              });
              return [createWriteFileTool({ mutator }), createEditFileTool({ mutator, workspaceFilesystem: workspaceFs, workingDir: hostWorkingDir })];
          })();

    return [
        createExecuteCommandTool({
            sandboxClient,
            sandbox: step.sandbox,
            workflowId: step.workflowId,
            stepId: step.stepId,
            nextFunctionId: step.nextFunctionId,
            deadlineMs: step.deadlineMs,
            defaultCwd: sandboxWorkingDir,
            markExecActive,
            ...(lineageCollector ? { lineageCollector, mountRoot: `/${step.analysisId}` } : {}),
        }),
        ...mutateTools,
        createReadFileTool(workspaceFs, hostWorkingDir),
        createListFilesTool(workspaceFs, hostWorkingDir),
        createFileStatTool(workspaceFs, hostWorkingDir),
        createGrepTool(workspaceFs, hostWorkingDir),
        ...(embedding ? [createWorkspaceSearchTool(pool, embedding)] : []),
    ];
}

/**
 * Build one sandbox `AgentDefinition`. The system prompt is composed once
 * (SOUL kernel + agent body + sandbox standards) — no processors, no
 * conversational layer (sandbox agents are not user-facing). Tools are
 * resolved against the closed allowlist; the workspace surface is always
 * wired regardless of meta.
 */
export function createSandboxAgent(deps: SandboxAgentDeps, meta: AgentMeta, body: string, opts: SandboxAgentPromptOptions = {}): AgentDefinition {
    const appendStandards = opts.appendAnalysisStepStandards ?? true;
    const sandboxLayer = appendStandards ? [sandboxOrientCorePrompt, sandboxAnalysisStepStandardsPrompt] : [sandboxOrientCorePrompt];
    const agentBody = [body, ...sandboxLayer].map((s) => s.trim()).join("\n\n");

    // Substitute the concrete in-sandbox paths the agent sees so the orient-core
    // path model is accurate per step (see the harness-workspace-tools spec), not boilerplate prose.
    const analysisRoot = `/${deps.step.analysisId}`;
    const workingDir = toSandboxPath(deps.step.workspaceRoot, deps.step.analysisId, deps.step.allowedWritePrefix);
    const resolvedBody = agentBody.split("{{WORKING_DIR}}").join(workingDir).split("{{ANALYSIS_ROOT}}").join(analysisRoot);

    const systemPrompt = composeSystemPrompt(resolvedBody, {
        includeConversationalStyle: false,
    });

    const skillTools = deps.skillsDir ? Object.values(createSkillTools({ skillsDir: deps.skillsDir, skills: meta.skills })) : [];
    const tools: Tool[] = [
        ...buildWorkspaceTools(deps, opts.readOnly ?? false),
        ...skillTools,
        ...resolveSandboxTools(deps, meta.tools),
        ...(deps.blockerHolder ? [createReportBlockerTool(deps.blockerHolder)] : []),
    ];

    return {
        id: meta.id,
        systemPrompt,
        model: deps.model,
        tools,
        maxIterations: meta.defaultMaxSteps ?? SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS,
    };
}
