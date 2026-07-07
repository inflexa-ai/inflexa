/**
 * The conversation agent — the harness composition root.
 *
 * `createConversationAgent` is the one place dependencies are exploded apart
 * (see the harness-durable-runtime spec): it receives the shared deps once — `ChatProvider`, `Pool`,
 * `EmbeddingProvider`, the model id — and hands each tool exactly what it
 * needs. Pure leaf tools take nothing; dependency-bearing tools get their
 * factory inputs. By the time `runAgent` sees a tool it is fully dep-bound;
 * the wiring lines below *are* the dependency graph, made visible.
 *
 * The system prompt is static composition — SOUL kernel + SOUL conversational
 * + the conversation prompt — with no processor pipeline.
 *
 * `executePlan` is wired here — it launches the DBOS `executeAnalysis` parent
 * workflow under `workflowId = runId` (the bare run UUID) through the
 * `RunLauncher` seam and returns the runId (results are pull-only via
 * `inspectRun` on a later turn). `run_ephemeral`
 * is wired here too — it mints a run authorization, starts the turn-scoped DBOS
 * `ephemeral` workflow, and awaits the result inline; chat disconnect cancels
 * the workflow and it is never recovered. `iterateReport` is wired here too — in-process Nunjucks
 * rendering driven by the in-process `report-builder` agent (no sandbox);
 * the 4 custom report tools (`build_report`, `submit_report`,
 * `preview_snapshot`, `mint_preview_url`) are constructed inside the runner
 * so they share closure-captured outcome state + preview-dir paths.
 * The workspace read surface (`read_file`, `grep`, `workspace_search`) is
 * wired here over the `WorkspaceFilesystem` seam.
 */

import type { Pool } from "pg";

import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { AgentDefinition } from "../loop/types.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { Tool } from "../tools/define-tool.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { conversationPrompt } from "../prompts/conversation.js";
import { composeSystemPrompt } from "./system-prompt.js";

// Bio-lookup leaf tools (pure — no dependencies).
import {
    searchGeneTool,
    searchPathwayTool,
    lookupGoTermTool,
    searchInteractionsTool,
    searchCompoundsTool,
    getBioactivityTool,
    searchTargetsTool,
    getMechanismTool,
    getDrugInfoTool,
    searchPubchemCompoundTool,
    getPubchemCrossRefsTool,
    getPubchemAssaysTool,
    searchOpenTargetsTool,
    getTargetSafetyTool,
    searchPharmgkbTool,
    searchFaersTool,
    searchClinicalTrialsTool,
    searchGeoDatasetsTool,
    searchDgidbTool,
    searchBgeeExpressionTool,
    getImpcKoProfileTool,
    checkSafetyPanelTool,
} from "../tools/bio/index.js";
import { createNcbiTools, createChemDbTools, type BioToolKeys } from "../tools/bio/keys.js";

// Dependency-bearing tool factories.
import { createGeneratePlanTool, createLiteratureReviewerTool, createInspectRunTool, createGenerateAnalogyReportTool } from "../tools/research/index.js";
import {
    createFileStatTool,
    createGrepTool,
    createListFilesTool,
    createReadFileTool,
    createShowPlanTool,
    createWorkspaceSearchTool,
    showFileTool,
} from "../tools/workspace/index.js";
import { showUserTool } from "../tools/display/index.js";
import { createUpdateWorkingMemoryTool } from "../tools/memory/index.js";
import { createExecutePlanTool } from "../tools/execute-plan.js";
import { createRunEphemeralTool } from "../tools/run-ephemeral.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import { createIterateReportTool, type IterateReportDeps } from "../tools/iterate-report.js";
import type { EphemeralWorkflowInput, EphemeralResult } from "../execution/ephemeral-runner.js";

/** Canonical agent id — the single source of truth. */
export const CONVERSATION_AGENT_ID = "conversation-agent" as const;

/** Runaway guard — heavy tool-driving turns need generous headroom. */
const CONVERSATION_MAX_ITERATIONS = 50;

/** The shared dependencies the composition root explodes apart. */
export interface ConversationAgentDeps {
    /** The LLM seam every loop-driving tool runs its sub-agent on. */
    readonly provider: ChatProvider;
    /** Postgres pool — plan persistence, run inspection, workspace index, working memory. */
    readonly pool: Pool;
    /** Embedding seam — workspace semantic search. */
    readonly embedding: EmbeddingProvider;
    /** Workspace filesystem read seam — `read_file` and `grep`. */
    readonly workspaceFs: WorkspaceFilesystem;
    /** Model id — provenance / metric label; the provider owns the wire model. */
    readonly model: string;
    /**
     * Registered `executeAnalysis` workflow callable — produced by
     * `registerExecuteAnalysis` (wired by `assembleCoreRuntime`). `executePlan`
     * launches it through the `RunLauncher` seam to start the run.
     */
    readonly executeAnalysisWorkflow: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    /**
     * Registered `ephemeral` workflow — `run_ephemeral` mints a run authorization,
     * starts it, and awaits the result inline within the chat turn.
     */
    readonly ephemeralWorkflow: (input: EphemeralWorkflowInput) => Promise<EphemeralResult>;
    /** Filesystem root every sandbox-mounted volume resolves under. */
    readonly sessionsBasePath: string;
    /**
     * Async-edge run-authorization seam — injected, not constructed here.
     * `execute_plan` and `run_ephemeral` turn the caller's opaque auth into a
     * durable `RunSession` through it. The managed root injects the platform
     * realization; the OSS root injects the local one.
     */
    readonly runAuthorizer: RunAuthorizer;
    /**
     * Durable-run launch seam — `execute_plan` and `run_ephemeral` start their
     * workflows through it so the durability engine stays out of the tools.
     */
    readonly runLauncher: RunLauncher;
    /**
     * Preview-publishing seam factory for `iterate_report` — injected, not
     * constructed here. The managed root closes its platform deps over this; the
     * OSS root returns the "unavailable" publisher.
     */
    readonly createPreviewPublisher: IterateReportDeps["createPreviewPublisher"];
    /** API keys for the external bio/chem data sources. */
    readonly bioKeys: BioToolKeys;
    /** Root templates dir for in-process report rendering (`iterateReport`). */
    readonly templatesDir: string;
    /** Headless-Chrome config for report snapshot/preview rendering. */
    readonly chrome: ChromeConfig;
    /**
     * Host resource policy — per-step ceilings + machine budget. `generate_plan`
     * states the ceilings to the planner and validates against them;
     * `execute_plan` snapshots the budget into the workflow input. Absent,
     * planning guidance and scheduling keep their legacy behavior.
     */
    readonly resourcePolicy?: ResourcePolicy;
}

/** Build the conversation `AgentDefinition` with every tool fully dep-bound. */
export function createConversationAgent(deps: ConversationAgentDeps): AgentDefinition {
    const {
        provider,
        pool,
        embedding,
        workspaceFs,
        model,
        executeAnalysisWorkflow,
        ephemeralWorkflow,
        sessionsBasePath,
        runAuthorizer,
        runLauncher,
        createPreviewPublisher,
        bioKeys,
        templatesDir,
        chrome,
        resourcePolicy,
    } = deps;
    const workingMemory = createWorkingMemory(pool);
    const ncbi = createNcbiTools(bioKeys);
    const chemDb = createChemDbTools(bioKeys);

    const tools: Tool[] = [
        // Bio-lookup.
        searchGeneTool,
        searchPathwayTool,
        lookupGoTermTool,
        searchInteractionsTool,
        ncbi.searchPubMed,
        ncbi.getArticleDetails,
        ncbi.getArticleFullText,
        // ChEMBL.
        searchCompoundsTool,
        getBioactivityTool,
        searchTargetsTool,
        getMechanismTool,
        getDrugInfoTool,
        // PubChem.
        searchPubchemCompoundTool,
        getPubchemCrossRefsTool,
        getPubchemAssaysTool,
        // Translational medicine.
        searchOpenTargetsTool,
        getTargetSafetyTool,
        searchPharmgkbTool,
        searchFaersTool,
        searchClinicalTrialsTool,
        searchGeoDatasetsTool,
        searchDgidbTool,
        // Preclinical.
        searchBgeeExpressionTool,
        getImpcKoProfileTool,
        // Off-target liability.
        checkSafetyPanelTool,
        // EPA CompTox.
        chemDb.searchToxcast,
        chemDb.searchCtxHazard,
        chemDb.searchCtxChemical,
        chemDb.searchCtxExposure,
        // Execution.
        createInspectRunTool(pool),
        createGeneratePlanTool({ provider, pool, model, resourcePolicy }),
        createExecutePlanTool({
            pool,
            executeAnalysisWorkflow,
            runAuthorizer,
            runLauncher,
            resourcePolicy,
        }),
        createRunEphemeralTool({
            workflow: ephemeralWorkflow,
            runAuthorizer,
            runLauncher,
        }),
        createIterateReportTool({
            provider,
            pool,
            sessionsBasePath,
            model,
            templatesDir,
            chrome,
            createPreviewPublisher,
        }),
        // Display.
        showUserTool,
        createShowPlanTool(pool),
        showFileTool,
        // Batch literature/biology research (sub-agent as a loop-driving tool).
        createLiteratureReviewerTool({ provider, model, bioKeys }),
        // Cross-domain analogy generation (sub-agent as a loop-driving tool).
        createGenerateAnalogyReportTool({ provider, model, bioKeys }),
        // Workspace semantic search + raw read/grep over the read seam.
        createWorkspaceSearchTool(pool, embedding),
        createReadFileTool(workspaceFs),
        createListFilesTool(workspaceFs),
        createFileStatTool(workspaceFs),
        createGrepTool(workspaceFs),
        // Working memory.
        createUpdateWorkingMemoryTool(workingMemory),
    ];

    return {
        id: CONVERSATION_AGENT_ID,
        systemPrompt: composeSystemPrompt(conversationPrompt),
        model,
        tools,
        maxIterations: CONVERSATION_MAX_ITERATIONS,
    };
}
