/**
 * The read-only surface of the workspace for an agent that plans or interprets the work of a run: the file reads,
 * the semantic search, and the data profile. Each tool reads the tree of the analysis of its session, and no tool
 * writes.
 */

import type { Querier } from "../../state/db.js";
import type { EmbeddingProvider } from "../../providers/types.js";
import type { WorkspaceFilesystem } from "../../workspace/filesystem.js";
import type { Tool } from "../define-tool.js";
import { createInspectDataProfileTool } from "../research/inspect-data-profile.js";
import type { WorkspaceSearchQuerier } from "./workspace-search.js";
import { createFileStatTool, createGrepTool, createListFilesTool, createReadFileTool, createWorkspaceSearchTool } from "./index.js";

export type ReadSurfaceDeps = {
    readonly workspaceFs: WorkspaceFilesystem;
    readonly pool: Querier & WorkspaceSearchQuerier;
    /** Absent: the agent gets no `workspace_search`. */
    readonly embedding?: EmbeddingProvider;
};

export function createReadSurfaceTools(deps: ReadSurfaceDeps): Tool[] {
    return [
        createReadFileTool(deps.workspaceFs),
        createListFilesTool(deps.workspaceFs),
        createFileStatTool(deps.workspaceFs),
        createGrepTool(deps.workspaceFs),
        ...(deps.embedding ? [createWorkspaceSearchTool(deps.pool, deps.embedding)] : []),
        createInspectDataProfileTool(deps.pool),
    ];
}
