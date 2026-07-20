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
 * `WorkspaceFilesystem`, `inspect_data_profile` over the shared `Pool`, and the
 * bio/literature/context7/run-inspection tools its `meta.tools` allowlist names.
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
import { createListAvailablePackagesTool, createListAvailableRefsTool } from "../../tools/sandbox/index.js";

// Context7 docs (pure leaves).
import { queryDocsTool, resolveLibraryIdTool } from "../../tools/research/context7-docs.js";

// Run-inspection (dependency-bearing).
import { createInspectRunTool } from "../../tools/research/inspect-run.js";

// Data-profile retrieval (dependency-bearing) — always-on, see `createSandboxAgent`.
import { createInspectDataProfileTool } from "../../tools/research/inspect-data-profile.js";

// Bio leaf tools.
import {
    checkSafetyPanelTool,
    chemblTool,
    getImpcKoProfileTool,
    lookupGoTermTool,
    openTargetsTool,
    pubchemTool,
    searchBgeeExpressionTool,
    searchClinicalTrialsTool,
    createSearchDgidbTool,
    searchFaersTool,
    searchGeneTool,
    searchGeoDatasetsTool,
    searchGwasCatalogTool,
    searchInteractionsTool,
    searchPathwayTool,
    searchPharmgkbTool,
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
import type { Logger } from "../../lib/logger.js";

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
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
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
    /**
     * Host path of the reference store — the same bytes the sandbox mounts at
     * `/mnt/refs`. Omit when no store is provisioned; reference discovery then
     * reports the store as unavailable rather than failing.
     */
    readonly refStorePath?: string;
    /**
     * Host path of the library store's `packages.txt`. Omit when the host mounts
     * the store at the sandbox's own path; a host whose store is baked into the
     * image must inject its extracted copy, or the inventory reads as unknown.
     */
    readonly packagesFile?: string;
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
 * Resolve `meta.tools` into the bio/research tools record. The workspace
 * read/mutate tools and `inspect_data_profile` are added by `createSandboxAgent`
 * regardless of meta — they are the always-on substrate, not in the allowlist.
 */
function resolveSandboxTools(deps: SandboxAgentDeps, tools: readonly SandboxToolName[]): Tool[] {
    const ncbi = createNcbiTools(deps.bioKeys);
    const chemDb = createChemDbTools(deps.bioKeys);
    const registry: Record<SandboxToolName, Tool> = {
        listAvailablePackages: createListAvailablePackagesTool({ ...(deps.packagesFile ? { packagesFile: deps.packagesFile } : {}) }),
        listAvailableRefs: createListAvailableRefsTool({ ...(deps.refStorePath ? { refStorePath: deps.refStorePath } : {}) }),
        resolveLibraryId: resolveLibraryIdTool,
        queryDocs: queryDocsTool,
        inspectRun: createInspectRunTool(deps.pool),
        pubmed: ncbi.pubmed,
        searchGene: searchGeneTool,
        searchPathway: searchPathwayTool,
        lookupGoTerm: lookupGoTermTool,
        searchInteractions: searchInteractionsTool,
        chembl: chemblTool,
        pubchem: pubchemTool,
        opentargets: openTargetsTool,
        searchPharmgkb: searchPharmgkbTool,
        searchFaers: searchFaersTool,
        searchClinicalTrials: searchClinicalTrialsTool,
        searchGeoDatasets: searchGeoDatasetsTool,
        searchClinvar: ncbi.searchClinvar,
        searchDgidb: createSearchDgidbTool({ ...(deps.logger ? { logger: deps.logger } : {}) }),
        searchGwasCatalog: searchGwasCatalogTool,
        searchDisgenet: chemDb.searchDisgenet,
        searchDrugbank: chemDb.searchDrugbank,
        searchBgeeExpression: searchBgeeExpressionTool,
        getImpcKoProfile: getImpcKoProfileTool,
        checkSafetyPanel: checkSafetyPanelTool,
        comptox: chemDb.comptox,
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

function createMarkExecActive(deps: SandboxAgentDeps): (execId: string) => Promise<void> {
    return (execId: string): Promise<void> =>
        setActiveExecId(deps.pool, deps.step.runId, deps.step.stepId, execId).match(
            () => {},
            () => {},
        );
}

/** Build the workspace mutate + read tools every sandbox agent receives. In
 *  `readOnly` mode the write_file/edit_file pair is omitted; execute_command
 *  and the read tools stay. */
function buildWorkspaceTools(deps: SandboxAgentDeps, readOnly: boolean): Tool[] {
    const { step, sandboxClient, workspaceFs, pool, embedding, lineageCollector } = deps;
    // Registry tagging is a best-effort watchdog backstop (`run-exec.ts` already
    // swallows a throw here); fold a `DbError` into a no-op so a registry write
    // failure neither fails the exec nor surfaces as an unhandled rejection.
    const markExecActive = createMarkExecActive(deps);

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
                  ...(lineageCollector ? { lineageCollector } : {}),
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
 * (SOUL execution core + agent body + sandbox standards) — no processors, and
 * neither human-facing SOUL layer: a sandbox agent is headless, so the identity
 * and conversational layers are dead weight in its context while every hard
 * guardrail it does need rides in the execution core. Tools are resolved
 * against the closed allowlist; the workspace surface is always wired
 * regardless of meta.
 *
 * The composed `systemPrompt` is a **pure function of the agent type** — nothing
 * from `deps.step` reaches it, so two steps of one run, and two runs of one
 * analysis, send a byte-identical ~20k-char prefix that the provider's prompt
 * cache can actually reuse. Keep it that way: a single interpolated id or path
 * makes every step's prefix unique again, and each step pays a full cache write
 * and reads nothing back. Per-step values belong in the step's briefing (its
 * first user message — see `prompts/briefing.ts`), which names the working
 * directory, the analysis root, the dataset, and what each dependency produced.
 */
export function createSandboxAgent(deps: SandboxAgentDeps, meta: AgentMeta, body: string, opts: SandboxAgentPromptOptions = {}): AgentDefinition {
    const appendStandards = opts.appendAnalysisStepStandards ?? true;
    const sandboxLayer = appendStandards ? [sandboxOrientCorePrompt, sandboxAnalysisStepStandardsPrompt] : [sandboxOrientCorePrompt];
    const agentBody = [body, ...sandboxLayer].map((s) => s.trim()).join("\n\n");

    const systemPrompt = composeSystemPrompt(agentBody);

    const skillTools = deps.skillsDir ? Object.values(createSkillTools({ skillsDir: deps.skillsDir, skills: meta.skills })) : [];
    const tools: Tool[] = [
        ...buildWorkspaceTools(deps, opts.readOnly ?? false),
        // Always-on, not in the `meta.tools` allowlist: the data profile is the only
        // record of what the analysis's input dataset IS, and no file carries it (the
        // profiler's scratch tree is deleted on completion). An agent that cannot pull
        // it has no fallback but to re-derive organism, dimensions, and format from the
        // raw bytes — so every sandbox agent gets it, whatever its meta declares.
        createInspectDataProfileTool(deps.pool),
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
