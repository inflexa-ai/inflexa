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
 * roster omits those tools, and no runtime guard blocks them. No tool runs a
 * container.
 *
 * A derivation of a table runs in a script (`run_script`), and it changes no
 * analysis: it mints no run id, it registers no artifact, and it writes under the
 * directory of the session alone.
 *
 * The definition carries no per-session value. The system prompt composes through
 * `composeSystemPrompt` with the identity part and the conversational part, the
 * same composition as the conversation agent. Thus the prompt prefix stays constant
 * across threads, and the provider cache reuses it.
 */

import type { Pool } from "pg";

import type { AuthContext, Identity } from "../auth/types.js";
import type { CompactionRules } from "../loop/compaction.js";
import type { ToolOutputStore } from "../loop/tool-output.js";
import type { AgentDefinition } from "../loop/types.js";
import { createReadToolOutputTool } from "../tools/read-tool-output.js";
import type { ReportSessionStateStore } from "../state/report-session-state.js";
import type { Tool } from "../tools/define-tool.js";
import type { EmbeddingProvider, ProviderOptions } from "../providers/types.js";
import type { WorkspaceFilesystem } from "../workspace/filesystem.js";
import { reportSessionDir, type ResolveWorkspaceRoot } from "../workspace/paths.js";
import { createDocumentTools, createReadPdfTool } from "../tools/script/file-tools.js";
import type { ChromeConfig } from "../lib/chrome.js";
import type { AcquireEyes } from "../lib/eyes.js";
import type { Logger } from "../lib/logger.js";
import type { ThreadStore } from "../memory/thread-store.js";
import type { ReferenceResolver } from "../report-model/reference-resolver.js";
import type { ReportVersionStore } from "../state/report-versions.js";
import type { ReportSessionStateGateway } from "../tools/report-authoring/authoring-tools.js";
import { createReportAuthoringTools } from "../tools/report-authoring/authoring-tools.js";
import type { ProvenanceSeam } from "../provenance/seam.js";
import {
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
import { createReportScriptTools } from "../tools/report-session/script-tools.js";
import type { ScriptRuntime } from "../tools/script/run-script.js";
import { createScriptScratch } from "../tools/script/scratch.js";

/** Canonical agent id -- distinct from the id of the old templating agent. */
export const REPORT_SESSION_AGENT_ID = "report-session" as const;

/**
 * Runaway guard. A full session — orient, compose each section, preview,
 * look, record — drives more small tool calls than a conversation turn, thus it
 * gets the headroom of the report runner (REPORT_AGENT_MAX_STEPS).
 */
const REPORT_SESSION_MAX_ITERATIONS = 200;

/** A session is one long turn that holds page captures, thus it compacts only during the turn, at a higher budget. */
const REPORT_SESSION_COMPACTION: CompactionRules = { budget: 250_000 };

/**
 * One tool call for each reply. Each authoring tool edits the one draft of the thread, and the calls of
 * one reply run at the same time, thus two edits in one round can land in either order.
 */
export const REPORT_SESSION_PROVIDER_OPTIONS: ProviderOptions = {
    anthropic: { disableParallelToolUse: true },
    openai: { parallelToolCalls: false },
};

/**
 * The shared dependencies of the report agent. The gateway binds the per-session
 * state to the thread, thus every tool that touches the state gets the same
 * gateway. The resolver factory is optional, because a resolver realization can be
 * absent, and the preview tool and the record tool degrade as data when it is.
 */
export type ReportSessionAgentDeps = {
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
    /** Derivation ledger -- `write_derived` appends one record for each derived table. */
    readonly derivations: Pick<ReportSessionStateStore, "appendDerivation">;
    /** Thread store -- the record tool reads the anchor of the report thread, and the preview tool names it. */
    readonly threads: Pick<ThreadStore, "getThread" | "setAutoTitle">;
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
    readonly makeResolver?: (scope: { analysisId: string; identity: Identity; auth: AuthContext }) => Promise<ReferenceResolver>;
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
    /**
     * The provenance seam -- the acts of the session as typed events, and the frozen document of the
     * analysis as opaque bytes. The tools that change the draft, preview the page, and
     * record a version each emit through the session member, thus one bound member carries the whole
     * session. The preview asks the read member before each render, and the page then carries the
     * document. An unbound member emits nothing, or gives absence, and every tool acts the same.
     */
    readonly provenance?: ProvenanceSeam;
    /** Operational logging seam; omitted falls back to no-op. */
    readonly logger?: Logger;
    /** Adds `read_tool_output`. The loop of a report turn must keep its texts in the same store. */
    readonly toolOutputStore?: ToolOutputStore;
    /** Where the VM of `run_script` comes from. A bundled host gives the embedded paths; see `ScriptRuntime`. */
    readonly scriptRuntime?: ScriptRuntime;
};

/** Build the report `AgentDefinition` with every tool bound to its deps. */
export function createReportSessionAgent(deps: ReportSessionAgentDeps): AgentDefinition {
    const { model, pool, embedding, workspaceFs, gateway, resolveWorkspaceRoot, store, threads, chrome, eyes, makeResolver, resolvePageAsset, logger } = deps;
    const { derivations, makeSessionPages, resolvePageUrl, provenance } = deps;
    // The seam rides into each tool that lands an act of the session, thus the composition binds it one
    // time and no tool reads a second source.
    const observation = provenance ? { provenance } : {};
    const authoring = createReportAuthoringTools(gateway, { ...observation, logger });

    const tools: Tool[] = [
        // The read surface toward the analysis. It roams the tree read-only.
        createReadFileTool(workspaceFs),
        createListFilesTool(workspaceFs),
        createFileStatTool(workspaceFs),
        createGrepTool(workspaceFs),
        ...(deps.toolOutputStore ? [createReadToolOutputTool(deps.toolOutputStore)] : []),
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
            logger,
        }),
        // The render-and-preview tool. It resolves the page root per call.
        createPreviewReportTool({
            gateway,
            resolveWorkspaceRoot,
            threads,
            makeResolver,
            resolvePageAsset,
            makeSessionPages,
            // The preview is the one site that carries the document into the page, thus the read member
            // reaches this tool alone.
            ...observation,
            logger,
        }),
        // The eyes tool. It opens the rendered page in headless Chrome.
        createExaminePageTool({
            gateway,
            resolveWorkspaceRoot,
            chrome,
            eyes,
            resolvePageUrl,
            logger,
        }),
        // The record tool. It gates the whole document, records one version, then prunes each
        // derived table that the recorded document does not bind.
        createRecordVersionTool({
            gateway,
            store,
            threads,
            resolveWorkspaceRoot,
            makeResolver,
            ...observation,
            logger,
        }),
    ];

    // A derivation of a table of up to the read cap runs in a script, thus it starts no container. The scripts
    // of a session stay beside its page.
    const scriptScratch = createScriptScratch({ resolveWorkspaceRoot, sessionDir: reportSessionDir, provenance, logger });
    // A PDF of the report is a document that a script builds from the content of the session, not a print of the
    // page. Its images come from the directory of the session alone, thus no unpinned file reaches it.
    const scriptTools = [
        ...createReportScriptTools({ gateway, workspaceFs, resolveWorkspaceRoot, derivations, provenance, logger }),
        createReadPdfTool({ workspaceFs, resolveWorkspaceRoot }),
        ...createDocumentTools({
            workspaceFs,
            resolveWorkspaceRoot,
            scratch: scriptScratch,
            imageScope: (session) => (session.scope.threadId === undefined ? undefined : reportSessionDir(session.scope.threadId)),
        }),
    ];

    return {
        id: REPORT_SESSION_AGENT_ID,
        systemPrompt: composeSystemPrompt(reportSessionPrompt, { identity: true, conversational: true }),
        model,
        tools,
        scriptTools,
        scriptRuntime: deps.scriptRuntime,
        scriptScratch,
        maxIterations: REPORT_SESSION_MAX_ITERATIONS,
        compaction: REPORT_SESSION_COMPACTION,
        providerOptions: REPORT_SESSION_PROVIDER_OPTIONS,
    };
}
