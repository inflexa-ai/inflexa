import type { EmitFn, EventSource } from "@inflexa-ai/harness";

// The `inflexa chat` emit sink — renders one in-process `EmitFn` stream to a
// plain-text terminal (task 4.3 / design D5). It is deliberately coarse: this
// is the walking-skeleton dev surface, not the daemon+TUI renderer that #33
// M3/M4 replaces it with. Three rules are load-bearing and each maps to a
// chat-command spec requirement:
//
//   1. COPY-ON-RECEIVE. In-process `emit` shares mutable references with the
//      agent loop (the same hazard the TUI's clone-before-store rule guards).
//      Every branch extracts the strings/ids/statuses it renders at receipt and
//      NEVER retains the received event or its `data` object. Printing is
//      synchronous inside `emit`, so a caller mutating a part after emitting it
//      cannot change what was already written.
//   2. TOP-LEVEL ONLY. Events whose `source.callPath` is deeper than the
//      top-level agent (sub-agent traffic: planner, literature reviewer) are
//      dropped — the same depth filter the managed SSE route applies. `source`
//      is present on loop orchestration events and on tool-emitted data parts;
//      stream events (text deltas) carry none, so they always pass.
//   3. ACCUMULATE, RENDER COARSELY. Text deltas are written as received (no
//      typewriter/pacing — settled repo-wide); the terminal itself is the
//      accumulator. Tool activity prints a one-line chip on start and its
//      outcome on finish. `data-plan`/`data-run-card` render their embedded
//      content; every other conversation part prints a one-line tagged mention
//      so the skeleton OBSERVES unknown traffic rather than hiding it.
//
// stdout carries the conversation; stderr carries diagnostics — the sink splits
// them so a caller can pipe the transcript cleanly. Output is plain ASCII: the
// `GLYPHS` registry is a `src/tui/` rule, and this is a text-command surface.

/**
 * Where the printer writes. Injected so the unit tests drive a pure recording
 * sink; production wires `out → process.stdout.write` and `errLine → console.error`.
 */
export type ChatSink = {
    /** Conversation output — written verbatim, no trailing newline added (deltas accumulate). */
    readonly out: (s: string) => void;
    /** One diagnostic line to stderr (a newline is the sink's concern). */
    readonly errLine: (s: string) => void;
};

/**
 * The small per-turn API the chat REPL drives. `emit` is the `EmitFn` handed to
 * `runAgent` — the command also routes the streaming provider wrapper's per-token
 * `onText` callback through it as `text-delta` events (see chat.ts), so deltas
 * and loop/tool events share one sink and one set of rules. `finishTurn` flushes
 * and resets per-turn state (dangling tool chips, the streamed-text flag).
 */
export type ChatPrinter = {
    readonly emit: EmitFn;
    /**
     * Close out the turn. `fallbackText` is the turn's final assistant text
     * (from `finalText(runAgent result)`): printed only when the turn streamed
     * no `text-delta`s — the deltas and the final text are the SAME content, so
     * this both prevents the double print on a streamed turn and keeps a
     * delta-less turn (or one run without the streaming wrapper) from rendering
     * nothing.
     */
    readonly finishTurn: (fallbackText?: string) => void;
};

/** Extract the `EventSource` an event carries, if any — only some categories have one. */
function eventSource(event: Parameters<EmitFn>[0]): EventSource | undefined {
    // `source` is required on loop orchestration events, optional on data parts,
    // and absent on stream events. `in` is the honest presence test across the union.
    return "source" in event && event.source ? event.source : undefined;
}

/** ms as a compact human string for the tool-chip completion line. */
function formatMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Read a plan card's render fields off the `unknown` `data` payload. The wire
 * payload is the harness's `PlanCardData` (flat: `{id, planId, title?, steps}`),
 * but `ChatDataPart.data` is typed `unknown`, so this narrows defensively and
 * copies every field it keeps — no reference to `data` survives the call.
 */
function readPlanCard(data: unknown): { planId: string; title: string; steps: { id: string; name: string; agent: string }[] } {
    // `data` is external/loop-owned; treat it as a loose record and pull only
    // what renders, coercing missing/mistyped fields to empty rather than throwing.
    const d = (data ?? {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(d.steps) ? d.steps : [];
    const steps = rawSteps.map((s) => {
        const step = (s ?? {}) as Record<string, unknown>;
        return {
            id: typeof step.id === "string" ? step.id : "",
            name: typeof step.name === "string" ? step.name : "",
            agent: typeof step.agent === "string" ? step.agent : "",
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
 * (design D5 says "runId + status", but `RunCardData`/`RunCardPart` expose
 * `{runId, planId, title, stepCount}`), so this renders identity + step count.
 */
function readRunCard(data: unknown): { runId: string; title: string; stepCount: number } {
    const d = (data ?? {}) as Record<string, unknown>;
    return {
        runId: typeof d.runId === "string" ? d.runId : "",
        title: typeof d.title === "string" ? d.title : "",
        stepCount: typeof d.stepCount === "number" ? d.stepCount : 0,
    };
}

/**
 * Build a chat printer over `sink`. Holds only per-turn primitive state (the
 * streamed-text flag and open tool chips keyed by id → name+start-time) — never
 * a received object — so copy-on-receive holds by construction.
 */
export function createChatPrinter(sink: ChatSink): ChatPrinter {
    let streamedText = false;
    // toolUseId → the primitives needed to close its chip. Storing the extracted
    // name (a string copy) and a timestamp, never the event, keeps copy-on-receive.
    const openTools = new Map<string, { name: string; startedAt: number }>();

    const emit: EmitFn = (event) => {
        // Rule 2: sub-agent traffic stays out of the transcript.
        const src = eventSource(event);
        if (src && src.callPath.length > 1) return;

        switch (event.type) {
            case "text-delta":
                // Rule 3: write as received; the terminal accumulates.
                streamedText = true;
                sink.out(event.text);
                return;
            case "done":
                // Stream terminal marker — the text already rendered via deltas.
                return;
            case "iteration":
                // Loop iteration boundary — orchestration, not transcript content.
                return;
            case "tool-started": {
                const name = event.name;
                openTools.set(event.toolUseId, { name, startedAt: Date.now() });
                sink.out(`\n  [tool] ${name} running...\n`);
                return;
            }
            case "tool-finished": {
                const name = event.name;
                const started = openTools.get(event.toolUseId);
                openTools.delete(event.toolUseId);
                const dur = started ? ` (${formatMs(Date.now() - started.startedAt)})` : "";
                sink.out(event.isError ? `  [tool] ${name} error\n` : `  [tool] ${name} done${dur}\n`);
                return;
            }
            default: {
                // Only `ChatDataPart` remains (its `type` is `data-${string}`).
                renderDataPart(event.type, event.data);
                return;
            }
        }
    };

    function renderDataPart(type: `data-${string}`, data: unknown): void {
        switch (type) {
            case "data-plan": {
                const plan = readPlanCard(data);
                const heading = plan.title || plan.planId;
                sink.out(`\n  [plan] ${heading} (${plan.planId})\n`);
                for (const step of plan.steps) sink.out(`    - ${step.id} ${step.name} [${step.agent}]\n`);
                return;
            }
            case "data-run-card": {
                const run = readRunCard(data);
                sink.out(`\n  [run] ${run.runId}: ${run.title} (${run.stepCount} step(s))\n`);
                return;
            }
            default:
                // Rule 3: observe unknown parts, do not swallow them.
                sink.out(`  [part:${type}]\n`);
                return;
        }
    }

    function finishTurn(fallbackText?: string): void {
        // Non-streaming `runAgent` path: nothing arrived as deltas, so print the
        // final assistant text now (a streaming loop that emitted deltas skips this).
        if (!streamedText && fallbackText && fallbackText.trim().length > 0) {
            sink.out(fallbackText);
        }
        // A turn aborted mid-tool leaves a chip open — close it honestly.
        for (const [, { name }] of openTools) sink.out(`  [tool] ${name} interrupted\n`);
        // Separate this turn's output from the next prompt.
        sink.out("\n");
        streamedText = false;
        openTools.clear();
    }

    return { emit, finishTurn };
}
