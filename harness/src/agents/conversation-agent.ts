/**
 * The conversation agent — the harness composition root.
 *
 * `createConversationAgent` is the one place dependencies are exploded apart
 * (see the harness-durable-runtime spec): it receives the shared deps once — `ChatProvider`, `Pool`,
 * `EmbeddingProvider`, the model id — and hands each tool exactly what it
 * needs. Pure leaf tools take nothing; dependency-bearing tools get their
 * factory inputs. By the time `runLoop` sees a tool it is fully dep-bound;
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
 * wired here over the `WorkspaceFilesystem` seam, and the write pair
 * (`write_file`, `edit_file`) over the session-scoped `WorkspaceMutator` —
 * confined to the analysis root, with one provenance session event per
 * successful write.
 */

import type { Pool } from "pg";

import type { ExecuteAnalysisInput, ExecuteAnalysisResult } from "../workflows/execute-analysis.js";
import type { EnsureSessionStateResult } from "../app/report-session-runtime.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { AcquireEyes } from "../lib/eyes.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import type { AgentDefinition } from "../loop/types.js";
import type { SubAgentRegistrar } from "../loop/sub-agent.js";
import type { ChatProvider, EmbeddingProvider } from "../providers/types.js";
import type { Tool } from "../tools/define-tool.js";
import { createReadToolOutputTool } from "../tools/read-tool-output.js";
import type { ExtendAnalysisFarm } from "../sandbox/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import { createWorkingMemory } from "../memory/working-memory.js";
import { createEditIntentStore } from "../state/edit-intents.js";
import { composeSystemPrompt } from "./system-prompt.js";

import type { KnowledgeClient } from "../tools/knowledge/index.js";
import { plannerCatalogOf } from "./sandbox-catalog.js";
import { mcpFailureNotice, requiredRoleSetup, type CatalogServices } from "../catalog/equip.js";
import { agentOfRole, resolveCatalog } from "../catalog/resolve.js";
import { createSkillTools } from "../tools/sandbox/skills.js";
import type { TurnAgent } from "./turn-agent.js";

// Dependency-bearing tool factories.
import { createGeneratePlanTool, createInspectRunTool, createInspectDataProfileTool, createGenerateAnalogyReportTool } from "../tools/research/index.js";
import {
    createEditFileTool,
    createFileStatTool,
    createGrepTool,
    createListFilesTool,
    createReadFileTool,
    createSessionWorkspaceMutator,
    createReadPlanTool,
    createShowPlanTool,
    createWorkspaceSearchTool,
    createWriteFileTool,
    showFileTool,
} from "../tools/workspace/index.js";
import { showUserTool } from "../tools/display/index.js";
import { createUpdateWorkingMemoryTool } from "../tools/memory/index.js";
import type { EnvironmentStorePaths } from "../config/environment-stores.js";
import { createListAvailablePackagesTool } from "../tools/sandbox/list-available-packages.js";
import { createListAvailableRefsTool } from "../tools/sandbox/list-available-refs.js";
import { createDownloadRefTool } from "../tools/sandbox/download-ref.js";
import { createExecuteAnalysisTool } from "../tools/execute-analysis.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { RunLauncher } from "../execution/run-launcher.js";
import type { ProvenanceSeam } from "../provenance/seam.js";
import type { SyncSessionFile } from "../workspace/session-files.js";
import { createStartReportSessionTool } from "../tools/start-report-session.js";
import type { Logger } from "../lib/logger.js";
import type { CompactionRules } from "../loop/compaction.js";
import type { UsageRecorder } from "../billing/usage-recorder.js";
import type { ScriptRuntime } from "../tools/script/run-script.js";
import { createScriptFileTools } from "../tools/script/file-tools.js";
import { createScriptScratch } from "../tools/script/scratch.js";
import { conversationSessionDir } from "../workspace/paths.js";

/** Canonical agent id — the single source of truth. */
export const CONVERSATION_AGENT_ID = "conversation-agent" as const;

/** Runaway guard — heavy tool-driving turns need generous headroom. */
const CONVERSATION_MAX_ITERATIONS = 200;

/** Compaction budgets, in the input tokens of a request. */
const CONVERSATION_COMPACTION: CompactionRules = { turnStartBudget: 200_000, budget: 200_000 };

/**
 * The shared dependencies the composition root explodes apart. The environment
 * store paths give this agent and its planner the same view of what is staged and
 * what is importable that a sandbox agent has — read host-side, so answering
 * "does this environment have X?" costs a lookup rather than a container.
 */
export type ConversationAgentDeps = EnvironmentStorePaths & {
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /**
     * LLM usage-accounting seam, handed to every loop-driving tool this agent
     * owns so a sub-agent's calls land in the same ledger as the turn's.
     * Omitted falls back to the no-op recorder.
     */
    readonly usageRecorder?: UsageRecorder;
    /** Adds `read_tool_output`, and each loop-driving tool gives the same store to its sub-agent. */
    readonly toolOutputStore?: ToolOutputStore;
    /**
     * The agent catalog. Each turn reads it: the connectors, the skills, and the MCP servers of the agent, the
     * executors of `execute_analysis`, and whether the analogy reasoner is on.
     */
    readonly services: CatalogServices;
    /** The LLM seam every loop-driving tool runs its sub-agent on. */
    readonly provider: ChatProvider;
    /**
     * Makes the function of each sub-agent of the agent: the planner and the analogy reporter. The assembly gives
     * `registerSubAgent`, thus a sub-agent of a turn workflow runs as a child workflow. A test gives `inProcessSubAgent`.
     */
    readonly registerSubAgent: SubAgentRegistrar;
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
     * The knowledge service client, for the planner that `generate_plan` drives.
     * Absent, the planner attaches no knowledge tool. The conversation agent
     * itself gets `knowledge_recommend` through `hostTools`, from the embedder.
     */
    readonly knowledge?: KnowledgeClient;
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
     * The provenance seam. `start_report_session` hands it to its spawn, which
     * emits the creation of the session at the moment that the child lands.
     * The session-scoped mutator behind `write_file` and `edit_file` emits one
     * `write-file` session event for each successful write.
     */
    readonly provenance?: ProvenanceSeam;
    /**
     * The host copy of each file that the agent writes: a derived file or a script of `run_script`, owned by the
     * thread, and a `write_file` or `edit_file` write, owned by the analysis. See `SyncSessionFile`.
     */
    readonly syncSessionFile?: SyncSessionFile;
    /**
     * Embedder-contributed conversation-tool seam — additional tools the host
     * supplies, appended after the built-in roster. The harness stays agnostic to
     * what they do; each receives the same `ToolContext` (including `ask`) as any
     * built-in tool.
     */
    readonly hostTools?: readonly Tool[];
    /** Where the VM of `run_script` comes from. A bundled host gives the embedded paths; see `ScriptRuntime`. */
    readonly scriptRuntime?: ScriptRuntime;
    /**
     * The farm-extension seam of the embedder. When it is bound,
     * `execute_analysis` links the packages of the plan into the farm of the
     * analysis before the launch, and a pool miss refuses the launch. Without
     * it, the link pass returns at once.
     */
    readonly extendAnalysisFarm?: ExtendAnalysisFarm;
};

/**
 * The conversation agent. The sub-agent workflows of its tools register one time, when the agent is made. Each turn
 * builds the `AgentDefinition` of the turn from the catalog of the moment, thus a change of the catalog reaches the
 * next turn, and the tools stay the same for the whole turn.
 */
export type ConversationAgent = TurnAgent;

/** Make the conversation agent with every tool fully dep-bound. */
export function createConversationAgent(deps: ConversationAgentDeps): ConversationAgent {
    const {
        provider,
        pool,
        embedding,
        workspaceFs,
        model,
        executeAnalysisWorkflow,
        runAuthorizer,
        runLauncher,
        chrome,
        hostTools,
        refStorePath,
        farmLockFile,
        imagePackagesFile,
        readPoolInventory,
        referenceDownloads,
        usageRecorder,
        toolOutputStore,
        services,
    } = deps;
    const workingMemory = createWorkingMemory(pool);
    // The write path of this agent: coordinates resolve per call from the
    // session's analysis scope, the write prefix is the analysis root, and
    // every successful write emits a `write-file` provenance session event.
    const mutator = createSessionWorkspaceMutator({
        resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
        provenance: deps.provenance,
        syncSessionFile: deps.syncSessionFile,
        logger: deps.logger,
    });

    // The scratch directory of each conversation: the scripts of `run_script`, and the files that they derive.
    const scriptScratch = createScriptScratch({
        resolveWorkspaceRoot: deps.resolveWorkspaceRoot,
        sessionDir: conversationSessionDir,
        provenance: deps.provenance,
        syncSessionFile: deps.syncSessionFile,
        logger: deps.logger,
    });

    // The direct tool and the script tool are one instance. A file that a script computes then reaches the path
    // that the user names, and its content never passes through the reply of the model.
    const writeFileTool = createWriteFileTool({ mutator });

    // Each sub-agent registers its workflow here, one time, before DBOS launches.
    const generatePlanTool = createGeneratePlanTool(
        {
            conversation: { provider, model },
            pool,
            usageRecorder,
            toolOutputStore,
            services,
            workspace: { workspaceFs, pool, embedding, resolveWorkspaceRoot: deps.resolveWorkspaceRoot },
            scriptRuntime: deps.scriptRuntime,
            knowledge: deps.knowledge,
            refStorePath,
            farmLockFile,
            imagePackagesFile,
            readPoolInventory,
            referenceDownloads,
            logger: deps.logger,
        },
        deps.registerSubAgent,
    );
    const generateAnalogyReportTool = createGenerateAnalogyReportTool(
        {
            provider,
            model,
            services,
            usageRecorder,
            toolOutputStore,
            logger: deps.logger,
            scriptRuntime: deps.scriptRuntime,
        },
        deps.registerSubAgent,
    );
    const executeAnalysisDeps = {
        pool,
        services,
        executeAnalysisWorkflow,
        runAuthorizer,
        runLauncher,
        farmLockFile,
        imagePackagesFile,
        readPoolInventory,
        extendAnalysisFarm: deps.extendAnalysisFarm,
        logger: deps.logger,
    };

    const forTurn = async (): Promise<AgentDefinition> => {
        const resolved = await resolveCatalog(services.catalog);
        const { agent: chat, equipment } = await requiredRoleSetup(services, resolved, "chat");
        const analogyOn = agentOfRole(resolved, "analogy") !== undefined;

        // The lookups and the light work on tables run in a script (`run_script`). Each tool asks no approval.
        const scriptTools: Tool[] = [
            // Tables of the workspace in, derived files and chart files out.
            ...createScriptFileTools({ workspaceFs, resolveWorkspaceRoot: deps.resolveWorkspaceRoot, scratch: scriptScratch }),
            writeFileTool,
            // The attached connectors: by default the identifier, annotation, network, structure, literature, web,
            // compound, target, variant, safety, trial, and dataset lookups.
            ...equipment.connectorTools,
            ...equipment.mcp.script,
        ];

        const tools: Tool[] = [
            // What reference data this install actually holds. The conversation agent is
            // where provisioning is decided — an embedder may give it a way to install more,
            // and a host that does asks the user to approve the download. Deciding that
            // blind is how a user gets asked to download something already installed, or
            // told nothing is missing when it is; this is the only tool that can tell.
            createListAvailableRefsTool({ refStorePath, canDownload: referenceDownloads !== undefined }),
            ...(referenceDownloads ? [createDownloadRefTool(referenceDownloads)] : []),
            // What the STORE holds, pool-scope where the embedder binds the reader:
            // the ask flow of this agent marks the packages the pool does not hold,
            // and the farm of a new analysis is empty — a farm view here would read
            // every pool package as absent. The farm-lock fallback keeps a host
            // with no pool reader on the old answer.
            createListAvailablePackagesTool({
                farmLockFile,
                imagePackagesFile,
                readPoolInventory,
            }),
            // Execution.
            createInspectRunTool(pool),
            // The dataset's own record. No file backs it — the DB row is the only copy.
            createInspectDataProfileTool(pool),
            generatePlanTool,
            createExecuteAnalysisTool(executeAnalysisDeps, plannerCatalogOf(resolved)),
            // The one report path. The tool starts a report thread as a child of the
            // conversation, and the user composes the report there with the Report
            // Builder.
            createStartReportSessionTool({
                pool,
                chrome,
                anchorSession: deps.anchorReportSession,
                eyes: deps.eyes,
                provenance: deps.provenance,
                logger: deps.logger,
            }),
            // Display.
            showUserTool,
            createShowPlanTool(pool),
            createReadPlanTool(pool),
            showFileTool,
            // Cross-domain analogy generation (sub-agent as a loop-driving tool), when the user keeps it on.
            ...(analogyOn ? [generateAnalogyReportTool] : []),
            // Workspace semantic search + raw read/grep over the read seam.
            createWorkspaceSearchTool(pool, embedding),
            createReadFileTool(workspaceFs),
            createListFilesTool(workspaceFs),
            createFileStatTool(workspaceFs),
            createGrepTool(workspaceFs),
            ...(toolOutputStore ? [createReadToolOutputTool(toolOutputStore)] : []),
            // Workspace write pair over the session-scoped mutate seam. The working
            // directory of this agent is the analysis root, so a write lands
            // anywhere inside its own analysis tree; `..`, a foreign analysis, and
            // a symlink escape stay refused. No sandbox is involved — the mutator
            // writes host-side, exactly as it does for a sandbox agent.
            writeFileTool,
            createEditFileTool({ mutator, workspaceFilesystem: workspaceFs, intents: createEditIntentStore(pool) }),
            // Working memory.
            createUpdateWorkingMemoryTool(workingMemory, pool),
            ...Object.values(createSkillTools({ store: equipment.skillStore, skills: equipment.skills })),
            ...equipment.mcp.direct,
            // Host-contributed tools ride the same context and dispatch path as the
            // built-ins; appended last so the built-in roster order stays fixed.
            ...(hostTools ?? []),
        ];

        const prompt = [chat.prompt, equipment.skillIndex, mcpFailureNotice(equipment.mcp.unavailable)].filter((part) => part !== undefined).join("\n\n");
        return {
            id: CONVERSATION_AGENT_ID,
            systemPrompt: composeSystemPrompt(prompt, { identity: true, conversational: true }),
            model,
            tools,
            scriptTools,
            scriptRuntime: deps.scriptRuntime,
            scriptScratch,
            maxIterations: CONVERSATION_MAX_ITERATIONS,
            compaction: CONVERSATION_COMPACTION,
        };
    };

    return { id: CONVERSATION_AGENT_ID, forTurn };
}
