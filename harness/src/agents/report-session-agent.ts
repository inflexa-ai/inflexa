/**
 * The Report Builder agent -- the agent that talks to the user on a report thread.
 *
 * `createReportSessionAgent` is the composition root of the report path. It gets
 * the shared deps one time, and it hands each tool exactly what it needs. The
 * authoring tools, the listing tool, the preview tool, the eyes tool, and the record
 * tool bind to the session-state gateway, thus one assembled definition serves every
 * thread, and the per-session state stays behind the tool boundary.
 *
 * The roster is read-only toward the analysis. It holds the workspace read tools,
 * the workspace search, the run inspection, and the data-profile inspection. It
 * holds no planner, no run launcher, no working-memory write, and no sandbox
 * mutate surface. Thus no tool starts a run, and no tool changes an analysis. The
 * roster omits those tools, and no runtime guard blocks them.
 *
 * The derivation tool is the one tool that runs a container, and it changes no
 * analysis either. It mints no run id, it registers no artifact, and it writes under
 * the directory of the session alone.
 *
 * The definition carries no per-session value. The system prompt composes through
 * `composeSystemPrompt` with the identity part and the conversational part, the
 * same composition as the conversation agent. Thus the prompt prefix stays constant
 * across threads, and the provider cache reuses it.
 */

import type { Pool } from "pg";

import type { AuthContext } from "../auth/types.js";
import type { RunAuthorizer } from "../execution/run-authorizer.js";
import type { AgentDefinition } from "../loop/types.js";
import type { DeriveTableRunner } from "../tools/report-session/derive-table.js";
import type { ReportSessionStateStore } from "../state/report-session-state.js";
import type { Tool } from "../tools/define-tool.js";
import type { EmbeddingProvider } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import type { ResolveWorkspaceRoot } from "../workspace/paths.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { AcquireEyes } from "../lib/eyes.js";
import type { Logger } from "../lib/logger.js";
import type { ThreadStore } from "../memory/thread-store.js";
import type { ReferenceResolver } from "../report-model/reference-resolver.js";
import type { ReportVersionStore } from "../state/report-versions.js";
import type { ReportSessionStateGateway } from "../tools/report-authoring/authoring-tools.js";
import { createReportAuthoringTools } from "../tools/report-authoring/authoring-tools.js";
import {
    createDeriveTableTool,
    createExaminePageTool,
    createListPinnedArtifactsTool,
    createPreviewReportTool,
    createRecordVersionTool,
    type MakeSessionPagePublisher,
    type ResolvePageAsset,
    type ResolvePageUrl,
} from "../tools/report-session/index.js";
import { createFileStatTool, createGrepTool, createListFilesTool, createReadFileTool, createWorkspaceSearchTool } from "../tools/workspace/index.js";
import { createInspectDataProfileTool, createInspectRunTool } from "../tools/research/index.js";
import { reportSessionPrompt } from "../prompts/report-session.js";
import { composeSystemPrompt } from "./system-prompt.js";

/** Canonical agent id -- distinct from the id of the old templating agent. */
export const REPORT_SESSION_AGENT_ID = "report-session" as const;

/**
 * Runaway guard. A full session — orient, derive, compose each section, preview,
 * look, record — drives more small tool calls than a conversation turn, thus it
 * gets the headroom of the report runner (REPORT_AGENT_MAX_STEPS).
 */
const REPORT_SESSION_MAX_ITERATIONS = 200;

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
    /** Session-state gateway -- the authoring tools, the listing tool, the preview tool, the eyes tool, and the record tool bind to it. */
    readonly gateway: ReportSessionStateGateway;
    /** Workspace-root resolution seam -- the listing tool, the preview tool, and the eyes tool resolve the root per call. */
    readonly resolveWorkspaceRoot: ResolveWorkspaceRoot;
    /** Append-only version store -- the record tool gates the whole document first, then records one version. */
    readonly store: ReportVersionStore;
    /** Derivation ledger -- the derivation tool appends one record for each derived table. */
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    /**
     * Derivation-exec seam -- the derivation tool runs one ephemeral container for each derived table, and
     * the composition realizes this seam over a registered workflow. Omitted, the tool reports that the
     * composition gives no sandbox, and it derives nothing.
     */
    readonly runDerivation?: DeriveTableRunner;
    /**
     * Run-authorization seam -- the derivation tool authorizes the exec and revokes on every terminal path.
     * Omitted, the tool derives nothing, the same as an absent sandbox client.
     */
    readonly runAuthorizer?: RunAuthorizer;
    /** Thread reader -- the record tool reads the anchor of the report thread. */
    readonly threads: Pick<ThreadStore, "getThread">;
    /** Headless-Chrome config -- the eyes tool opens the rendered page. */
    readonly chrome: ChromeConfig;
    /**
     * Eyes seam -- where a browser comes from for one look. The eyes tool takes one lease for each look,
     * and it releases the lease after the look. Omitted, the tool falls back to the chrome config, and a
     * config that names no browser leaves the session with no look at all.
     */
    readonly eyes?: AcquireEyes;
    /**
     * Reference-resolution factory -- absent until a realization lands; the preview tool and the record tool
     * degrade as data. The factory binds one analysis, thus a tool makes the resolver over the scope of the call.
     */
    readonly makeResolver?: (scope: { analysisId: string; auth: AuthContext }) => ReferenceResolver;
    /**
     * Page-asset lookup -- the preview tool maps the module specifier of a manifest
     * entry onto a file on disk. Omitted falls back to the module resolution of the
     * installation of the harness.
     */
    readonly resolvePageAsset?: ResolvePageAsset;
    /**
     * Session-page publisher factory -- the hosted view of the rendered page. The factory
     * binds one analysis and the auth of the call, like `makeResolver`, thus the mint runs
     * under the credential of the caller. Bound, the preview tool builds the publisher over
     * the scope of the call, mints one grant after the page lands, and attaches the URL
     * beside the path. Omitted, the result carries the page path alone.
     */
    readonly makeSessionPages?: MakeSessionPagePublisher;
    /**
     * Page-URL formation of the eyes -- the URL that one look opens. A composition whose
     * browser cannot reach the workspace tree binds a resolver that names a served URL, and
     * the args carry the auth of the tool call beside the page identity. Omitted, the eyes
     * tool navigates through a `file://` URL of the page path.
     */
    readonly resolvePageUrl?: ResolvePageUrl;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
}

/** Build the report `AgentDefinition` with every tool bound to its deps. */
export function createReportSessionAgent(deps: ReportSessionAgentDeps): AgentDefinition {
    const { model, pool, embedding, workspaceFs, gateway, resolveWorkspaceRoot, store, threads, chrome, eyes, makeResolver, resolvePageAsset, logger } = deps;
    const { derivations, runDerivation, runAuthorizer, makeSessionPages, resolvePageUrl } = deps;
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
        // The orientation source of the pinned evidence. It reads the snapshot of the
        // thread, and it resolves the workspace root per call for the header columns.
        createListPinnedArtifactsTool({
            gateway,
            resolveWorkspaceRoot,
            ...(logger ? { logger } : {}),
        }),
        // The derivation tool. It reshapes the pinned evidence into one table under the
        // session directory, on the sandbox rails of the value tier.
        createDeriveTableTool({
            gateway,
            resolveWorkspaceRoot,
            derivations,
            ...(runDerivation ? { runDerivation } : {}),
            ...(runAuthorizer ? { runAuthorizer } : {}),
            ...(logger ? { logger } : {}),
        }),
        // The render-and-preview tool. It resolves the page root per call.
        createPreviewReportTool({
            gateway,
            resolveWorkspaceRoot,
            ...(makeResolver ? { makeResolver } : {}),
            ...(resolvePageAsset ? { resolvePageAsset } : {}),
            ...(makeSessionPages ? { makeSessionPages } : {}),
            ...(logger ? { logger } : {}),
        }),
        // The eyes tool. It opens the rendered page in headless Chrome.
        createExaminePageTool({
            gateway,
            resolveWorkspaceRoot,
            chrome,
            ...(eyes ? { eyes } : {}),
            ...(resolvePageUrl ? { resolvePageUrl } : {}),
            ...(logger ? { logger } : {}),
        }),
        // The record tool. It gates the whole document, records one version, then prunes each
        // derived table that the recorded document does not bind.
        createRecordVersionTool({
            gateway,
            store,
            threads,
            resolveWorkspaceRoot,
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
