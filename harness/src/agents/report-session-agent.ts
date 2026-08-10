/**
 * The Report Builder agent -- the agent that talks to the user on a report thread.
 *
 * `createReportSessionAgent` is the composition root of the report path. It gets
 * the shared deps one time, and it hands each tool exactly what it needs. The
 * authoring tools, the preview tool, the eyes tool, and the record tool bind to the
 * session-state gateway, thus one assembled definition serves every thread, and the
 * per-session state stays behind the tool boundary.
 *
 * The roster is read-only toward the analysis. It holds the workspace read tools,
 * the workspace search, the run inspection, and the data-profile inspection. It
 * holds no planner, no run launcher, no working-memory write, and no sandbox
 * mutate surface. Thus no tool starts a run, and no tool changes an analysis. The
 * roster omits those tools, and no runtime guard blocks them.
 *
 * The definition carries no per-session value. The system prompt composes through
 * `composeSystemPrompt` with the identity part and the conversational part, the
 * same composition as the conversation agent. Thus the prompt prefix stays constant
 * across threads, and the provider cache reuses it.
 */

import type { Pool } from "pg";

import type { AuthContext } from "../auth/types.js";
import type { AgentDefinition } from "../loop/types.js";
import type { Tool } from "../tools/define-tool.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { Logger } from "../lib/logger.js";
import type { ThreadStore } from "../memory/thread-store.js";
import type { ReferenceResolver } from "../report-model/reference-resolver.js";
import type { ReportVersionStore } from "../state/report-versions.js";
import type { ReportSessionStateGateway } from "../tools/report-authoring/authoring-tools.js";
import { createReportAuthoringTools } from "../tools/report-authoring/authoring-tools.js";
import { createExaminePageTool, createPreviewReportTool, createRecordVersionTool } from "../tools/report-session/index.js";
import { createFileStatTool, createGrepTool, createListFilesTool, createReadFileTool, createWorkspaceSearchTool } from "../tools/workspace/index.js";
import { createInspectDataProfileTool, createInspectRunTool } from "../tools/research/index.js";
import { reportSessionPrompt } from "../prompts/report-session.js";
import { composeSystemPrompt } from "./system-prompt.js";

/** Canonical agent id -- distinct from the id of the old templating agent. */
export const REPORT_SESSION_AGENT_ID = "report-session" as const;

/**
 * Runaway guard. A report turn drives many small tool calls, thus it needs the
 * same headroom as the conversation agent.
 */
const REPORT_SESSION_MAX_ITERATIONS = 50;

/**
 * The shared dependencies of the report agent. The gateway binds the per-session
 * state to the thread, thus every tool that touches the state gets the same
 * gateway. The resolver factory is optional, because a resolver realization can be
 * absent, and the preview tool and the record tool degrade as data when it is.
 */
export interface ReportSessionAgentDeps {
    /** Model id -- the provenance and metric label. The provider owns the wire model. */
    readonly model: string;
    /** Postgres pool -- workspace index, run inspection, and data-profile inspection. */
    readonly pool: Pool;
    /** Embedding seam -- workspace semantic search. */
    readonly embedding: EmbeddingProvider;
    /** Workspace filesystem read seam -- the four read tools. */
    readonly workspaceFs: WorkspaceFilesystem;
    /** Session-state gateway -- the authoring tools, the preview tool, the eyes tool, and the record tool bind to it. */
    readonly gateway: ReportSessionStateGateway;
    /** Workspace-root resolution seam -- the preview tool and the eyes tool resolve the page root per call. */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Append-only version store -- the record tool gates the whole document first, then records one version. */
    readonly store: ReportVersionStore;
    /** Thread reader -- the record tool reads the anchor of the report thread. */
    readonly threads: Pick<ThreadStore, "getThread">;
    /** Headless-Chrome config -- the eyes tool opens the rendered page. */
    readonly chrome: ChromeConfig;
    /**
     * Reference-resolution factory -- absent until a realization lands; the preview tool and the record tool
     * degrade as data. The factory binds one analysis, thus a tool makes the resolver over the scope of the call.
     */
    readonly makeResolver?: (scope: { analysisId: string; auth: AuthContext }) => ReferenceResolver;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
}

/** Build the report `AgentDefinition` with every tool bound to its deps. */
export function createReportSessionAgent(deps: ReportSessionAgentDeps): AgentDefinition {
    const { model, pool, embedding, workspaceFs, gateway, resolveWorkspaceRoot, store, threads, chrome, makeResolver, logger } = deps;
    const authoring = createReportAuthoringTools(gateway);

    const tools: Tool[] = [
        // The read surface toward the analysis. It roams the tree read-only.
        createReadFileTool(workspaceFs),
        createListFilesTool(workspaceFs),
        createFileStatTool(workspaceFs),
        createGrepTool(workspaceFs),
        createWorkspaceSearchTool(pool, embedding),
        createInspectRunTool(pool),
        createInspectDataProfileTool(pool),
        // The composition surface. Each authoring tool binds to the gateway, thus
        // two threads never share one draft.
        authoring.add_block,
        authoring.change_block,
        authoring.remove_block,
        authoring.move_block,
        authoring.set_title,
        authoring.read_outline,
        authoring.read_block,
        authoring.finish_draft,
        // The render-and-preview tool. It resolves the page root per call.
        createPreviewReportTool({
            gateway,
            resolveWorkspaceRoot,
            ...(makeResolver ? { makeResolver } : {}),
            ...(logger ? { logger } : {}),
        }),
        // The eyes tool. It opens the rendered page in headless Chrome.
        createExaminePageTool({
            gateway,
            resolveWorkspaceRoot,
            chrome,
            ...(logger ? { logger } : {}),
        }),
        // The record tool. It gates the whole document, then records one version.
        createRecordVersionTool({
            gateway,
            store,
            threads,
            ...(makeResolver ? { makeResolver } : {}),
            ...(logger ? { logger } : {}),
        }),
    ];

    return {
        id: REPORT_SESSION_AGENT_ID,
        systemPrompt: composeSystemPrompt(reportSessionPrompt, { identity: true, conversational: true }),
        model,
        tools,
        maxIterations: REPORT_SESSION_MAX_ITERATIONS,
    };
}
