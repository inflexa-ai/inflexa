/**
 * The name-plus-input detail resolver.
 *
 * The live loop holds the resolved `Tool` at dispatch and needs nothing. Every
 * other surface — the reload converter, a workflow's live-activity line — has a
 * tool NAME and a persisted input, so it needs a way back to the tool. This is
 * that way, and it is deliberately built over a tool list the CALLER supplies:
 *
 * - A name map internal to the harness could never see an embedder's tools. A
 *   host contributes tools through the host-tools seam, and those calls are as
 *   ambiguous in a transcript as any other.
 * - Two harness tools legitimately share one id (`write_file` exists in both the
 *   workspace surface and the report version store). A resolver built from one
 *   agent's list cannot hold both, because a tool list rejects a duplicate id at
 *   registry construction.
 *
 * It resolves through the same `computeDetail` the loop uses, so a reloaded
 * thread shows the same CALL detail the live turn showed.
 *
 * The bound is the input. A reload reconstructs from the persisted call alone, and a
 * tool that describes its own RESULT names a fact that the input cannot carry — a page
 * path, a recorded version. That line reaches the live surface on the finished event and
 * it does not reappear here, thus a reloaded call falls back to its call detail. Nothing
 * is persisted: storage stays the pure model transcript.
 */

import { computeDetail, type ToolCallDetail } from "../loop/tool-detail.js";
import { createNoopLogger } from "../lib/console-logger.js";
import type { Logger } from "../lib/logger.js";
import type { Tool } from "./define-tool.js";

/**
 * Maps a tool name plus a call's input to that call's detail. Yields
 * `undefined` for an unknown tool, a tool with no hook, and an input the tool's
 * schema rejects.
 */
export type ToolDetailResolver = (toolName: string, input: unknown) => ToolCallDetail | undefined;

/**
 * Build a resolver over `tools`. A duplicate id resolves to the first tool
 * declaring it; callers pass one agent's composed list, which a registry has
 * already rejected duplicates from.
 */
export function createDetailResolver(tools: readonly Tool[], logger?: Logger): ToolDetailResolver {
    const log = (logger ?? createNoopLogger()).named("tool-detail");
    const byId = new Map<string, Tool>();
    for (const tool of tools) {
        if (!byId.has(tool.id)) byId.set(tool.id, tool);
    }

    return (toolName, input) => {
        const tool = byId.get(toolName);
        return tool === undefined ? undefined : computeDetail(tool, input, log);
    };
}
