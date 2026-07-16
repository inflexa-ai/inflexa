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
 * the workflow and it is never recovered. Report authoring is wired here as the
 * pair `plan_report` (returns the report-brief schema + authoring rules
 * just-in-time as its result) + `submit_report` (validates the composed brief
 * and drives in-process Nunjucks rendering via the `report-builder` agent, no
 * sandbox). The 4 custom tools the builder itself drives (`build_report`, its
 * own terminal `submit_report`, `preview_snapshot`, `mint_preview_url`) are
 * constructed inside the runner so they share closure-captured outcome state +
 * preview-dir paths.
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
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { conversationPrompt } from "../prompts/conversation.js";
import { composeSystemPrompt } from "./system-prompt.js";

// Bio-lookup leaf tools (pure — no dependencies).
import {
    searchGeneTool,
    searchPathwayTool,
    lookupGoTermTool,
    searchInteractionsTool,
    chemblTool,
    pubchemTool,
    openTargetsTool,
    searchPharmgkbTool,
    searchFaersTool,
    searchClinicalTrialsTool,
    searchGeoDatasetsTool,
    createSearchDgidbTool,
    searchBgeeExpressionTool,
    getImpcKoProfileTool,
    checkSafetyPanelTool,
} from "../tools/bio/index.js";
import { createNcbiTools, createChemDbTools, type BioToolKeys } from "../tools/bio/keys.js";

// Dependency-bearing tool factories.
import {
    createGeneratePlanTool,
    createLiteratureReviewerTool,
    createInspectRunTool,
    createInspectDataProfileTool,
    createGenerateAnalogyReportTool,
} from "../tools/research/index.js";
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
import { planReportTool, createReportSubmitTool, type SubmitReportDeps } from "../tools/iterate-report.js";
import type { EphemeralWorkflowInput, EphemeralResult } from "../execution/ephemeral-runner.js";
import type { Logger } from "../lib/logger.js";

/** Canonical agent id — the single source of truth. */
export const CONVERSATION_AGENT_ID = "conversation-agent" as const;

/** Runaway guard — heavy tool-driving turns need generous headroom. */
const CONVERSATION_MAX_ITERATIONS = 50;

/** The shared dependencies the composition root explodes apart. */
export interface ConversationAgentDeps {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
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
    /** Workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
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
     * Preview-publishing seam factory for `submit_report` — injected, not
     * constructed here. The managed root closes its platform deps over this; the
     * OSS root returns the "unavailable" publisher.
     */
    readonly createPreviewPublisher: SubmitReportDeps["createPreviewPublisher"];
    /** API keys for the external bio/chem data sources. */
    readonly bioKeys: BioToolKeys;
    /** Root templates dir for in-process report rendering (`submit_report`). */
    readonly templatesDir: string;
    /** Skills root; the in-process report-builder gets `report-html` skill tools. */
    readonly skillsDir: string;
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
        resolveWorkspaceRoot,
        runAuthorizer,
        runLauncher,
        createPreviewPublisher,
        bioKeys,
        templatesDir,
        skillsDir,
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
        // Literature (search / details / fulltext behind one action).
        ncbi.pubmed,
        // ChEMBL (compounds / drug / mechanism / bioactivity / targets behind one action).
        chemblTool,
        // PubChem (compound / crossrefs / assays behind one action).
        pubchemTool,
        // Translational medicine.
        openTargetsTool,
        searchPharmgkbTool,
        searchFaersTool,
        searchClinicalTrialsTool,
        searchGeoDatasetsTool,
        createSearchDgidbTool({ ...(deps.logger ? { logger: deps.logger } : {}) }),
        // Preclinical.
        searchBgeeExpressionTool,
        getImpcKoProfileTool,
        // Off-target liability.
        checkSafetyPanelTool,
        // EPA CompTox (toxcast / hazard / chemical / exposure behind one dataset).
        chemDb.comptox,
        // Execution.
        createInspectRunTool(pool),
        // The dataset's own record. No file backs it — the DB row is the only copy.
        createInspectDataProfileTool(pool),
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
        // Report authoring: the always-on `plan_report` trigger delivers the
        // heavy brief schema + rules just-in-time as its result; `submit_report`
        // takes the composed brief as `unknown` and validates it in-execute, so
        // the ~12k schema never rides the always-on tool surface.
        planReportTool,
        createReportSubmitTool({
            provider,
            pool,
            resolveWorkspaceRoot,
            model,
            templatesDir,
            skillsDir,
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
        createUpdateWorkingMemoryTool(workingMemory, pool),
    ];

    return {
        id: CONVERSATION_AGENT_ID,
        systemPrompt: composeSystemPrompt(conversationPrompt, { identity: true, conversational: true }),
        model,
        tools,
        maxIterations: CONVERSATION_MAX_ITERATIONS,
    };
}
