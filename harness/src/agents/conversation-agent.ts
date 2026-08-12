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
 * `execute_analysis` is wired here — it launches the DBOS `executeAnalysis` parent
 * workflow under `workflowId = runId` (the bare run UUID) through the
 * `RunLauncher` seam and returns the runId (results are pull-only via
 * `inspectRun` on a later turn). `start_report_session` is the one report path.
 * It starts a report thread as a child of the conversation, and the Report
 * Builder composes the report in that thread.
 * The workspace read surface (`read_file`, `grep`, `workspace_search`) is
 * wired here over the `WorkspaceFilesystem` seam.
 */

import type { Pool } from "pg";

import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import type { EnsureSessionStateResult } from "../app/report-session-runtime.js";
import type { ResourcePolicy } from "../config/resource-limits.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { AcquireEyes } from "../lib/eyes.js";
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
    lookupAnnotationTool,
    searchInteractionsTool,
    chemblTool,
    pubchemTool,
    openTargetsTool,
    searchFaersTool,
    searchClinicalTrialsTool,
    searchGeoDatasetsTool,
    genePreclinicalProfileTool,
    targetSafetyTool,
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
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import { createListAvailablePackagesTool } from "../tools/sandbox/list-available-packages.js";
import { createListAvailableRefsTool } from "../tools/sandbox/list-available-refs.js";
import { createExecuteAnalysisTool } from "../tools/execute-analysis.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { SubmitReportDeps } from "../tools/iterate-report.js";
import { createStartReportSessionTool } from "../tools/start-report-session.js";
import type { Logger } from "../lib/logger.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { CitationResolver } from "../citations/types.js";
import { createResolveCitationTool } from "../tools/research/resolve-citation.js";

/** Canonical agent id — the single source of truth. */
export const CONVERSATION_AGENT_ID = "conversation-agent" as const;

/** Runaway guard — heavy tool-driving turns need generous headroom. */
const CONVERSATION_MAX_ITERATIONS = 50;

/**
 * The shared dependencies the composition root explodes apart. The environment
 * store paths give this agent and its planner the same view of what is staged and
 * what is importable that a sandbox agent has — read host-side, so answering
 * "does this environment have X?" costs a lookup rather than a container.
 */
export interface ConversationAgentDeps extends EnvironmentStorePaths {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /**
     * LLM usage-accounting seam, handed to every loop-driving tool this agent
     * owns so a sub-agent's calls land in the same ledger as the turn's.
     * Omitted falls back to the no-op recorder.
     */
    readonly usageRecorder?: UsageRecorder;
    /** Shared host-side bibliographic verification service. */
    readonly citationResolver: CitationResolver;
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
    /** Dedicated lower-cost model/provider for ad hoc specialist routing. */
    readonly utilityProvider: ChatProvider;
    readonly utilityModel: string;
    /**
     * Registered `executeAnalysis` workflow callable — produced by
     * `registerExecuteAnalysis` (wired by `assembleCoreRuntime`). `execute_analysis`
     * launches it through the `RunLauncher` seam to start the run.
     */
    readonly executeAnalysisWorkflow: (input: ExecuteAnalysisInput) => Promise<ExecuteAnalysisResult>;
    /**
     * The anchor operation of the report session runtime — produced by
     * `createReportSessionRuntime` and wired by `assembleCoreRuntime`. The spawn
     * of `start_report_session` runs it after the seed of the child lands, thus
     * the transcript anchor and the data snapshot pin at one moment.
     */
    readonly anchorReportSession: (threadId: string) => Promise<EnsureSessionStateResult>;
    /** Workspace-root resolution seam (see workspace/paths.ts). */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /**
     * Async-edge run-authorization seam — injected, not constructed here.
     * `execute_analysis` turns the caller's opaque auth into a
     * durable `RunSession` through it. The managed root injects the platform
     * realization; the OSS root injects the local one.
     */
    readonly runAuthorizer: RunAuthorizer;
    /**
     * Durable-run launch seam — `execute_analysis` starts its
     * workflows through it so the durability engine stays out of the tools.
     */
    readonly runLauncher: RunLauncher;
    /**
     * Preview-publishing seam factory. No tool of the roster reads it. The field
     * stays, because a change to the deps breaks an embedder at its composition
     * root.
     */
    readonly createPreviewPublisher: SubmitReportDeps["createPreviewPublisher"];
    /** API keys for the external bio/chem data sources. */
    readonly bioKeys: BioToolKeys;
    /** Root templates dir. No tool of the roster reads it. */
    readonly templatesDir: string;
    /** Skills root. No tool of the roster reads it. */
    readonly skillsDir: string;
    /** Headless-Chrome config for report snapshot/preview rendering. */
    readonly chrome: ChromeConfig;
    /**
     * The eyes of a report session — where a browser comes from for one look at
     * the rendered page. `start_report_session` hands it to its spawn, thus a
     * composition that binds the seam and names no browser still starts a
     * session. The assembly resolves the eyes one time, and the agent that looks
     * at a page reads that same answer.
     */
    readonly eyes?: AcquireEyes;
    /**
     * Host resource policy — per-step ceilings + machine budget. `generate_plan`
     * states the ceilings to the planner and validates against them;
     * `execute_analysis` snapshots the budget into the workflow input. Absent,
     * planning guidance and scheduling keep their legacy behavior.
     */
    readonly resourcePolicy?: ResourcePolicy;
    /**
     * Embedder-contributed conversation-tool seam — additional tools the host
     * supplies, appended after the built-in roster. The harness stays agnostic to
     * what they do; each receives the same `ToolContext` (including `ask`) as any
     * built-in tool.
     */
    readonly hostTools?: readonly Tool[];
}

/** Build the conversation `AgentDefinition` with every tool fully dep-bound. */
export function createConversationAgent(deps: ConversationAgentDeps): AgentDefinition {
    const {
        provider,
        pool,
        embedding,
        workspaceFs,
        model,
        utilityProvider,
        utilityModel,
        executeAnalysisWorkflow,
        runAuthorizer,
        runLauncher,
        bioKeys,
        chrome,
        resourcePolicy,
        hostTools,
        refStorePath,
        packagesFile,
        usageRecorder,
        citationResolver,
    } = deps;
    const workingMemory = createWorkingMemory(pool);
    const ncbi = createNcbiTools(bioKeys);
    const chemDb = createChemDbTools(bioKeys, { ...(deps.logger ? { logger: deps.logger } : {}) });

    const tools: Tool[] = [
        // Identifier resolution — the ENSG most other bio tools key off.
        searchGeneTool,
        // Functional annotation (GO / KEGG / Reactome behind one vocabulary) and
        // STRING networks + gene-set enrichment.
        lookupAnnotationTool,
        searchInteractionsTool,
        // Literature (search / details / fulltext behind one action).
        ncbi.pubmed,
        // Verification of one caller-supplied citation (distinct from discovery).
        createResolveCitationTool(citationResolver),
        // ChEMBL (compounds / drug / mechanism / bioactivity / targets behind one action).
        chemblTool,
        // PubChem (compound / crossrefs / assays behind one action).
        pubchemTool,
        // Target assessment: the integrated scored view, then the underlying records.
        openTargetsTool,
        // Genetic evidence — GWAS Catalog + DisGeNET + ClinVar behind one `sources`.
        chemDb.geneDiseaseEvidence,
        // Drug↔gene interactions — DGIdb + DrugBank + PharmGKB behind one `sources`.
        chemDb.drugGeneInteractions,
        searchFaersTool,
        searchClinicalTrialsTool,
        searchGeoDatasetsTool,
        // Preclinical — baseline expression + mouse knockout in one call.
        genePreclinicalProfileTool,
        // Target-level safety — the curated panel + Open Targets liabilities.
        targetSafetyTool,
        // EPA CompTox (toxcast / hazard / chemical / exposure behind one dataset).
        chemDb.comptox,
        // What reference data this install actually holds. The conversation agent is
        // where provisioning is decided — an embedder may give it a way to install more,
        // and a host that does asks the user to approve the download. Deciding that
        // blind is how a user gets asked to download something already installed, or
        // told nothing is missing when it is; this is the only tool that can tell.
        createListAvailableRefsTool({ ...(refStorePath ? { refStorePath } : {}) }),
        // What is importable inside a sandbox. Reads the same manifest a sandbox agent
        // reads, host-side — so "is scanpy available?" is a manifest lookup here rather
        // than launching analysis computation to run one import.
        createListAvailablePackagesTool({ ...(packagesFile ? { packagesFile } : {}) }),
        // Execution.
        createInspectRunTool(pool),
        // The dataset's own record. No file backs it — the DB row is the only copy.
        createInspectDataProfileTool(pool),
        createGeneratePlanTool({
            conversation: { provider, model },
            pool,
            resourcePolicy,
            usageRecorder,
            ...(refStorePath ? { refStorePath } : {}),
            ...(packagesFile ? { packagesFile } : {}),
            ...(deps.logger ? { logger: deps.logger } : {}),
        }),
        createExecuteAnalysisTool({
            pool,
            executeAnalysisWorkflow,
            runAuthorizer,
            runLauncher,
            resourcePolicy,
            utilityProvider,
            utilityModel,
            ...(deps.logger ? { logger: deps.logger } : {}),
        }),
        // The one report path. The tool starts a report thread as a child of the
        // conversation, and the user composes the report there with the Report
        // Builder.
        createStartReportSessionTool({
            pool,
            chrome,
            anchorSession: deps.anchorReportSession,
            ...(deps.eyes ? { eyes: deps.eyes } : {}),
            ...(deps.logger ? { logger: deps.logger } : {}),
        }),
        // Display.
        showUserTool,
        createShowPlanTool(pool),
        showFileTool,
        // Batch literature/biology research (sub-agent as a loop-driving tool).
        createLiteratureReviewerTool({ provider, model, bioKeys, citationResolver, usageRecorder }),
        // Cross-domain analogy generation (sub-agent as a loop-driving tool).
        createGenerateAnalogyReportTool({ provider, model, bioKeys, usageRecorder }),
        // Workspace semantic search + raw read/grep over the read seam.
        createWorkspaceSearchTool(pool, embedding),
        createReadFileTool(workspaceFs),
        createListFilesTool(workspaceFs),
        createFileStatTool(workspaceFs),
        createGrepTool(workspaceFs),
        // Working memory.
        createUpdateWorkingMemoryTool(workingMemory, pool),
        // Host-contributed tools ride the same context and dispatch path as the
        // built-ins; appended last so the built-in roster order stays fixed.
        ...(hostTools ?? []),
    ];

    return {
        id: CONVERSATION_AGENT_ID,
        systemPrompt: composeSystemPrompt(conversationPrompt, { identity: true, conversational: true }),
        model,
        tools,
        maxIterations: CONVERSATION_MAX_ITERATIONS,
    };
}
