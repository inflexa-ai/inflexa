import type { EmitFn, EventSource, PlanPart } from "@inflexa-ai/harness";

import type { PlanCardStepView } from "../../types/session.ts";

// The readers that turn one raw `EmitFn` event, or one harness part, into the primitives a surface
// renders.
//
// Two surfaces consume them, and that is the whole reason they sit here rather than inside either
// one: the TUI (the conversation store `tui/hooks/conversation.ts` and its renderer
// `tui/layout/message_block.tsx`, which reads a stored plan card through `readPlanCard`) and the dev
// REPL printer (`dev/chat.ts`). Both must narrate the same stream the same way — a plan card the TUI reads
// as three steps and the REPL reads as two would be a difference with no cause behind it — so every
// reader with two consumers lives here and neither surface re-derives it.
//
// A reader with ONE consumer stays with that consumer instead, per the single-caller rule of
// `cli/CLAUDE.md`. `eventDepth` (`tui/hooks/conversation.ts`) is the case to know about: it repeats
// the `source` presence read of `eventSource` below, because exporting a private helper for one
// outside caller widens this surface for less than the repeat costs. A change to `EventSource`
// touches that function too.
//
// Every reader COPIES what it keeps. An in-process `emit` shares mutable references with the agent
// loop, so a reader that retained the received event would hand its caller a value the loop can
// still change underneath it.
//
// The event readers read the raw loop event. The part reader takes a part that `checkChatPart`
// validated where the part arrived, thus it reads each field as the type gives it.

/** Extract the `EventSource` an event carries, if any — only some categories have one. */
function eventSource(event: Parameters<EmitFn>[0]): EventSource | undefined {
    // `source` is required on loop orchestration events, optional on data parts,
    // and absent on stream events. `in` is the honest presence test across the union.
    return "source" in event && event.source ? event.source : undefined;
}

/**
 * True when `event` originates from a SUB-AGENT loop (planner, literature
 * reviewer) — its `source.callPath` is deeper than the top-level agent — so the
 * transcript drops it (the same depth filter the managed SSE route applies). The
 * top-level chat agent's `callPath` has length 1; anything longer is sub-agent
 * traffic. Events without a `source` (stream text deltas) are never sub-agent, so
 * they always pass. Exported so the TUI adapter shares this exact ruleset instead
 * of re-deriving it. `callPath` is external/loop-owned, so it is
 * guarded with `Array.isArray` — a malformed source lacking the array is treated
 * as top-level rather than throwing.
 */
export function isSubAgentEvent(event: Parameters<EmitFn>[0]): boolean {
    const src = eventSource(event);
    return src !== undefined && Array.isArray(src.callPath) && src.callPath.length > 1;
}

/**
 * A short human phrase for what a sub-agent event says its emitter is doing, or `null` for an event
 * that describes no activity (a `done` marker, a data part, a text delta — prose the sub-agent is
 * writing for its own caller, not a description of work).
 *
 * Shared by the REPL printer and the TUI reducer so the two narrate sub-agent work identically. The
 * agent id leads because a nested call chain is otherwise unattributable: `tool bash` alone does not
 * say who ran it.
 */
export function subAgentActivityLabel(event: Parameters<EmitFn>[0]): string | null {
    const who = eventSource(event)?.agentId ?? "sub-agent";
    switch (event.type) {
        case "tool-started":
            return `${who}: ${event.name}`;
        case "tool-finished":
            return `${who}: ${event.name} done`;
        case "iteration":
            return `${who}: thinking`;
        default:
            return null;
    }
}

/**
 * Map a plan card to the fields that a surface renders. The receipt check validated the part, thus each
 * field is read as the type gives it. An absent optional field reads as empty, and each array is copied,
 * thus the view holds no reference to the part. Exported so the TUI renderer and the REPL printer share
 * the mapping.
 */
export function readPlanCard(part: PlanPart): { planId: string; title: string; steps: PlanCardStepView[] } {
    return {
        planId: part.planId,
        title: part.title ?? "",
        steps: (part.steps ?? []).map((step) => ({
            id: step.id,
            name: step.name,
            agent: step.agent,
            question: step.question,
            acceptance_criteria: [...(step.acceptance_criteria ?? [])],
            constraints: [...(step.constraints ?? [])],
            caveats: [...(step.caveats ?? [])],
            depends_on: [...step.depends_on],
            resources:
                step.resources === undefined ? null : { cpu: step.resources.cpu, memoryGb: step.resources.memoryGb, gpuCount: step.resources.gpu?.count ?? 0 },
            track: step.track ?? "",
            step_type: step.step_type ?? "",
        })),
    };
}
