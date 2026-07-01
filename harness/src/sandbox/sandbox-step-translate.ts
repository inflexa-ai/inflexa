/**
 * Pure translation between the agent-loop / sandbox event stream and the
 * typed per-step parts the frontend renders. No DBOS, no per-run state — just the
 * label mapping, the file-tree delta extraction/fold, and the chat-data-part
 * narrowing the `sandbox-step` workflow body composes into its emitters.
 */

import type { ChatDataPart, EmitFn } from "../loop/types.js";

/** Friendly live-activity label per sandbox tool id. Falls back to the raw
 *  tool name so a newly added tool still reads sensibly. */
const TOOL_ACTIVITY: Readonly<Record<string, string>> = {
    execute_command: "Running script",
    write_file: "Writing file",
    edit_file: "Editing file",
    read_file: "Reading file",
    grep: "Searching files",
    list_files: "Listing files",
};

/** Last path segment of a posix/win path-like string. */
function baseName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

/** Display file name for a tool's live-activity label, or null when the input
 *  carries no sensible name. Path tools (`write_file`/`edit_file`/`read_file`)
 *  carry `path`; `execute_command` carries an argv `command` whose first
 *  script-like token names what's running. */
function activityFileName(name: string, input: unknown): string | null {
    if (input === null || typeof input !== "object") return null;
    const obj = input as Record<string, unknown>;
    if (name === "execute_command") {
        const cmd = obj.command;
        if (!Array.isArray(cmd)) return null;
        const script = cmd.find((a): a is string => typeof a === "string" && /\.(py|R|r|sh|js|ts|ipynb)$/.test(a));
        return script ? baseName(script) : null;
    }
    return typeof obj.path === "string" && obj.path.length > 0 ? baseName(obj.path) : null;
}

export function activityForTool(name: string, input?: unknown): string {
    const label = TOOL_ACTIVITY[name] ?? `Running ${name}`;
    const file = activityFileName(name, input);
    return file ? `${label} ${file}` : label;
}

/** On-change working-tree delta the sandbox executor posts per exec (paths
 *  only; the executor skips directories). */
export interface SandboxTreeDelta {
    added?: string[];
    modified?: string[];
    removed?: string[];
}

/** Extract the tree delta from a `data-sandbox-event` part, or null when the
 *  part is some other sandbox event. The wrapper shape is set by
 *  `run-exec.ts`: `{ type: "data-sandbox-event", data: { execId, event } }`
 *  where `event` is the executor's `eventPayload`. */
export function sandboxTreeDelta(part: { type: string; data?: unknown }): SandboxTreeDelta | null {
    if (part.type !== "data-sandbox-event") return null;
    const inner = (part.data as { event?: { kind?: string; tree?: SandboxTreeDelta } } | undefined)?.event;
    if (!inner || inner.kind !== "file-tree" || !inner.tree) return null;
    return inner.tree;
}

/** Apply one on-change delta to the per-step cumulative path set. `added`
 *  and `modified` add the path; `removed` deletes it. Folding many deltas
 *  (one stream per exec, all against the same step working dir) yields the
 *  full set of files the step has produced so far. */
export function applyTreeDelta(files: Set<string>, delta: SandboxTreeDelta): void {
    for (const p of delta.added ?? []) files.add(p);
    for (const p of delta.modified ?? []) files.add(p);
    for (const p of delta.removed ?? []) files.delete(p);
}

/**
 * Narrow an `EmitFn` payload to `ChatDataPart`. The discriminator is the
 * `data-` prefix on `type`: orchestration events (`iteration`,
 * `tool-started`, `tool-finished`) and `ChatStreamEvent` (`text-delta`,
 * `done`) never start with `data-`.
 */
export function isChatDataPart(event: Parameters<EmitFn>[0]): event is ChatDataPart {
    return typeof (event as { type?: unknown }).type === "string" && (event as { type: string }).type.startsWith("data-");
}
