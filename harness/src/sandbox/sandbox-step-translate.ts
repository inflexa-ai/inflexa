/**
 * Pure translation between the agent-loop / sandbox event stream and the
 * typed per-step parts the frontend renders. No DBOS, no per-run state — just the
 * reconciliation-id construction, the label mapping, the file-tree delta
 * extraction/fold, and the chat-data-part narrowing a workflow body composes
 * into its emitters.
 */

import { z } from "zod";

import type { ActivityEntryPart, StepActivityPart, StepPhase, SynthesisPhase, SynthesisProgressPart } from "../contracts/chat-parts.js";
import { parseUnknownRecord } from "../lib/unknown-containers.js";
import type { ChatDataPart, EmitFn } from "../loop/types.js";
import type { ToolDetailResolver } from "../tools/detail-resolver.js";

/**
 * Stable reconciliation id for a step's reconciling parts
 * (`data-step-activity`, `data-step-file-tree`). One id per (runId, stepId)
 * so the run-stream fold collapses every phase transition latest-wins onto
 * a single frame. The client keys these by `stepId`, but the server fold
 * keys by part `id`, so the id MUST be unique per step within the run.
 *
 * Every producer of these parts mints its ids here: the id is a
 * reconciliation contract, and the fold collapses correctly only while all
 * producers construct it identically.
 */
export function stepPartId(kind: string, runId: string, stepId: string): string {
    return `${kind}-${runId}-${stepId}`;
}

/**
 * The two parts of one activity emission: the reconciling `data-step-activity` that holds the current activity,
 * and the `data-activity-entry` that keeps the emission in the run stream. Both carry the same phase, activity,
 * and time. `key` names the entry: the position of a body emission in the body of its workflow, or `tool-` and the
 * id of the call for the emission of a tool call. A recovered body counts the same body emissions again, and a
 * replayed tool step emits nothing, thus each entry keeps its id. Every producer mints the two parts here.
 */
export function activityEmission(
    frame: { readonly runId: string; readonly stepId: string },
    key: number | string,
    phase: StepPhase,
    activity: string,
    at: string,
): { readonly activity: StepActivityPart; readonly entry: ActivityEntryPart } {
    const { runId, stepId } = frame;
    return {
        activity: { type: "data-step-activity", id: stepPartId("step-activity", runId, stepId), runId, stepId, phase, activity, at },
        entry: { type: "data-activity-entry", id: `${stepPartId("activity-entry", runId, stepId)}-${key}`, runId, stepId, phase, activity, at },
    };
}

/** The key of the activity entry of one tool call. */
export function toolActivityKey(toolUseId: string): string {
    return `tool-${toolUseId}`;
}

/**
 * The two parts of one synthesis progress report: the reconciling `data-synthesis-progress` that holds the current
 * phase, and the `data-activity-entry` that keeps the report in the run stream under the synthesis step. `seq` is the
 * position of the report in the synthesis, so each entry has its own id. The `extra` fields stay on the progress part.
 */
export function synthesisEmission(
    runId: string,
    stepId: string,
    seq: number,
    phase: SynthesisPhase,
    activity: string,
    at: string,
    extra: Pick<SynthesisProgressPart, "reason" | "error">,
): { readonly progress: SynthesisProgressPart; readonly entry: ActivityEntryPart } {
    return {
        progress: { type: "data-synthesis-progress", id: `synthesis-progress-${runId}`, runId, phase, activity, at, ...extra },
        entry: { type: "data-activity-entry", id: `${stepPartId("activity-entry", runId, stepId)}-${seq}`, runId, stepId, phase, activity, at },
    };
}

/**
 * The live-activity phrase for one tool call: the tool's name, then its own
 * description of this call when it has one.
 *
 * The description comes from the tool's `describeCall` hook, resolved through
 * `resolveDetail` — the same resolver the chat chip and the reloaded transcript
 * use. A caller supplies the resolver for the agent whose calls it is
 * describing, because a sandbox agent's tool list is not the conversation
 * roster's and no single list serves both.
 *
 * The name always leads, and that is load-bearing rather than cosmetic. This
 * phrase is rendered alone, with no tool name beside it — unlike the chat chip,
 * which prints the name itself and can afford a bare detail. `write_file` and
 * `edit_file` both describe a call by its path, so a detail on its own would
 * render a write and an edit of the same file identically.
 *
 * A tool with no hook, an unknown tool, and an input its schema rejects all fall
 * back to the name alone. No verb is added: the phrase is carried on a part that
 * already states the phase, so "Running" would only restate it.
 */
export function activityForTool(name: string, input?: unknown, resolveDetail?: ToolDetailResolver): string {
    const detail = resolveDetail?.(name, input);
    return detail === undefined ? name : `${name} ${detail}`;
}

/** On-change working-tree delta the sandbox executor posts per exec (paths
 *  only; the executor skips directories). */
export type SandboxTreeDelta = {
    added?: string[];
    modified?: string[];
    removed?: string[];
};

const SandboxTreeDeltaSchema = z.object({
    added: z.array(z.string()).optional(),
    modified: z.array(z.string()).optional(),
    removed: z.array(z.string()).optional(),
});

/** Extract the tree delta from a `data-sandbox-event` part, or null when the
 *  part is some other sandbox event. The wrapper shape is set by
 *  `run-exec.ts`: `{ type: "data-sandbox-event", data: { event } }`
 *  where `event` is the executor's `eventPayload`. */
export function sandboxTreeDelta(part: { type: string; data?: unknown }): SandboxTreeDelta | null {
    if (part.type !== "data-sandbox-event") return null;
    const data = parseUnknownRecord(part.data);
    const inner = data === undefined ? undefined : parseUnknownRecord(data.event);
    if (!inner || inner.kind !== "file-tree") return null;
    const tree = SandboxTreeDeltaSchema.safeParse(inner.tree);
    return tree.success ? tree.data : null;
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
    return "type" in event && typeof event.type === "string" && event.type.startsWith("data-");
}
