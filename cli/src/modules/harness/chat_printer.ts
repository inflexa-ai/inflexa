import type { EmitFn, EventSource } from "@inflexa-ai/harness";

import type { AskCardStatus, PlanCardStepView } from "../../types/session.ts";

// The readers that turn one raw `EmitFn` event into the primitives a surface renders.
//
// Two surfaces consume them, and that is the whole reason they sit here rather than inside either
// one: the TUI conversation reducer (`tui/hooks/conversation.ts`) and the dev REPL printer
// (`dev/chat.ts`). Both must narrate the same stream the same way — a plan card the TUI reads as
// three steps and the REPL reads as two would be a difference with no cause behind it — so the
// coercion lives in exactly one place and neither surface re-derives it.
//
// Every reader COPIES what it keeps. An in-process `emit` shares mutable references with the agent
// loop, so a reader that retained the received `data` object would hand its caller a value the loop
// can still change underneath it. Each one extracts primitives at receipt and keeps no reference.
//
// The payloads are external and loop-owned, so every field is read-and-coerced rather than trusted:
// a missing or mistyped field becomes empty, never a throw. A surface renders what arrived.

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
 * guarded with `Array.isArray` (matching every other untrusted read here) — a
 * malformed source lacking the array is treated as top-level rather than throwing.
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
 * Read a plan card's render fields off the `unknown` `data` payload. The wire
 * payload is the harness's `PlanCardData` (flat: `{id, planId, title?, steps}`),
 * but `ChatDataPart.data` is typed `unknown`, so this narrows defensively and
 * copies every field it keeps — no reference to `data` survives the call.
 * Exported so the TUI adapter extracts card fields with this exact reader rather
 * than duplicating the coercion.
 */
export function readPlanCard(data: unknown): { planId: string; title: string; steps: PlanCardStepView[] } {
    // `data` is external/loop-owned; treat it as a loose record and pull only
    // what renders, coercing missing/mistyped fields to empty rather than throwing.
    const d = (data ?? {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(d.steps) ? d.steps : [];
    const steps = rawSteps.map((s) => {
        // Same rationale as `d`: each step is untrusted `unknown`, cast to a loose
        // record so every field below is read-and-coerced, never trusted.
        const step = (s ?? {}) as Record<string, unknown>;
        // Nested resource objects come from the same untrusted payload. These loose
        // records are only read through explicit primitive checks below.
        const resources = (step.resources ?? {}) as Record<string, unknown>;
        const gpu = (resources.gpu ?? {}) as Record<string, unknown>;
        const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
        const hasResources = typeof resources.cpu === "number" || typeof resources.memoryGb === "number" || typeof gpu.count === "number";
        return {
            id: typeof step.id === "string" ? step.id : "",
            name: typeof step.name === "string" ? step.name : "",
            agent: typeof step.agent === "string" ? step.agent : "",
            question: typeof step.question === "string" ? step.question : "",
            acceptance_criteria: strings(step.acceptance_criteria),
            constraints: strings(step.constraints),
            caveats: strings(step.caveats),
            depends_on: strings(step.depends_on),
            resources: hasResources
                ? {
                      cpu: typeof resources.cpu === "number" ? resources.cpu : 0,
                      memoryGb: typeof resources.memoryGb === "number" ? resources.memoryGb : 0,
                      gpuCount: typeof gpu.count === "number" ? gpu.count : 0,
                  }
                : null,
            track: typeof step.track === "string" ? step.track : "",
            step_type: typeof step.step_type === "string" ? step.step_type : "",
        };
    });
    return {
        planId: typeof d.planId === "string" ? d.planId : "",
        title: typeof d.title === "string" ? d.title : "",
        steps,
    };
}

/**
 * Read a run card's render fields off the `unknown` `data` payload (the
 * harness's `RunCardData`). Note the contract carries NO run status field
 * (`RunCardData`/`RunCardPart` expose `{runId, planId, title, stepCount}`),
 * so this renders identity + step count.
 * Exported alongside {@link readPlanCard} so the TUI adapter shares the reader.
 */
export function readRunCard(data: unknown): { runId: string; title: string; stepCount: number } {
    // `data` is external/loop-owned; cast to a loose record and read-and-coerce
    // every field (missing/mistyped → empty), never trusting the shape.
    const d = (data ?? {}) as Record<string, unknown>;
    return {
        runId: typeof d.runId === "string" ? d.runId : "",
        title: typeof d.title === "string" ? d.title : "",
        stepCount: typeof d.stepCount === "number" ? d.stepCount : 0,
    };
}

/** The recognized ask statuses, as a runtime set for the reader's narrow. Typed `AskCardStatus[]` so an entry can only be a valid status. */
const ASK_STATUSES: readonly AskCardStatus[] = ["pending", "resolved", "rejected", "aborted", "expired"];

/**
 * Read an ask part's render fields off the `unknown` `data` payload (the harness's `AskPart`:
 * `{id, title, command, detail?, status}`). Narrows defensively and copies every field it keeps —
 * no reference to `data` survives the call. An unrecognized or missing `status` maps to `expired`,
 * the SAFE TERMINAL: never `pending`, so a malformed re-emission can never resurrect a live prompt
 * or wedge the pending-asks queue. `id` becomes `askId` (the reconcile/answer key) to keep it distinct
 * from a card part's own fresh id. Exported so the TUI adapter extracts ask fields with this exact reader.
 */
export function readAskPart(data: unknown): { askId: string; title: string; command: string; detail?: string; status: AskCardStatus } {
    // `data` is external/loop-owned; cast to a loose record and read-and-coerce every field.
    const d = (data ?? {}) as Record<string, unknown>;
    const status: AskCardStatus =
        typeof d.status === "string" && (ASK_STATUSES as readonly string[]).includes(d.status) ? (d.status as AskCardStatus) : "expired";
    return {
        askId: typeof d.id === "string" ? d.id : "",
        title: typeof d.title === "string" ? d.title : "",
        command: typeof d.command === "string" ? d.command : "",
        ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
        status,
    };
}
