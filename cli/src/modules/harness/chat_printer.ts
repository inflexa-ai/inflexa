import { pathToFileURL } from "node:url";

import type { EmitFn, EventSource } from "@inflexa-ai/harness";

import { materializeTarget, readFileReference, readPresentation, readReportPreview, readReportPreviewFailed } from "./artifact_open.ts";
import type { OpenableEntry, OpenTarget, PresentationBody } from "../../types/session.ts";

// The `inflexa chat` emit sink — renders one in-process `EmitFn` stream to a
// plain-text terminal. It is deliberately coarse: this
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
    /**
     * The `EmitFn` sink handed to `runAgent` (and fed the streaming provider's
     * text deltas). Drops sub-agent traffic, renders each event category coarsely,
     * and never retains a received object (copy-on-receive).
     */
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

/** ms as a compact human string for the tool-chip completion line. */
function formatMs(ms: number): string {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Read a plan card's render fields off the `unknown` `data` payload. The wire
 * payload is the harness's `PlanCardData` (flat: `{id, planId, title?, steps}`),
 * but `ChatDataPart.data` is typed `unknown`, so this narrows defensively and
 * copies every field it keeps — no reference to `data` survives the call.
 * Exported so the TUI adapter extracts card fields with this exact reader rather
 * than duplicating the coercion.
 */
export function readPlanCard(data: unknown): { planId: string; title: string; steps: { id: string; name: string; agent: string }[] } {
    // `data` is external/loop-owned; treat it as a loose record and pull only
    // what renders, coercing missing/mistyped fields to empty rather than throwing.
    const d = (data ?? {}) as Record<string, unknown>;
    const rawSteps = Array.isArray(d.steps) ? d.steps : [];
    const steps = rawSteps.map((s) => {
        // Same rationale as `d`: each step is untrusted `unknown`, cast to a loose
        // record so every field below is read-and-coerced, never trusted.
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

/** Build an OSC 8 hyperlink whose VISIBLE text is `text` and whose target is `uri` — degrades to plain `text` on terminals without link support. */
function hyperlink(uri: string, text: string): string {
    return `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;
}

/** Render a text-shaped presentation table as aligned monospace columns (the REPL's plain-text table form). */
function formatTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((h, ci) => Math.max(h.length, ...rows.map((r) => (r[ci] ?? "").length)));
    const line = (cells: string[]): string => `    ${cells.map((c, ci) => (c ?? "").padEnd(widths[ci] ?? 0)).join("  ")}`.trimEnd();
    return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map((r) => line(headers.map((_, ci) => r[ci] ?? "")))].join("\n");
}

/**
 * How the printer resolves an openable entry to the absolute path it links to (materializing `echart`/`svg`
 * into the shared cache). Injectable so the printer's openable rendering is unit-testable without a booted
 * workspace; production omits it and gets the real {@link materializeTarget}.
 */
export type PrinterOptions = {
    /** The analysis whose workspace root + render cache resolve openable references. */
    readonly analysisId?: string;
    /** Resolve an entry's target to an absolute path (materializing when needed), or `null` when unavailable. */
    readonly resolvePath?: (analysisId: string, target: OpenTarget) => string | null;
};

/**
 * Build a chat printer over `sink`. Holds only per-turn primitive state (the
 * streamed-text flag and open tool chips keyed by id → name+start-time) — never
 * a received object — so copy-on-receive holds by construction.
 */
export function createChatPrinter(sink: ChatSink, options: PrinterOptions = {}): ChatPrinter {
    const analysisId = options.analysisId ?? "";
    const resolvePath =
        options.resolvePath ??
        ((aid: string, target: OpenTarget): string | null =>
            materializeTarget(aid, target).match(
                (path) => path,
                () => null,
            ));
    let streamedText = false;
    // toolUseId → the primitives needed to close its chip. Storing the extracted
    // name (a string copy) and a timestamp, never the event, keeps copy-on-receive.
    const openTools = new Map<string, { name: string; startedAt: number }>();

    const emit: EmitFn = (event) => {
        // Rule 2: sub-agent traffic (planner, literature reviewer) stays out of the
        // transcript — the shared depth filter, so the TUI adapter drops the same set.
        if (isSubAgentEvent(event)) return;

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
            case "data-presentation": {
                const view = readPresentation(data);
                if (view.shape === "inline") renderInlinePresentation(view.title, view.body);
                else renderOpenables(view.title, [view.entry]);
                return;
            }
            case "data-file-reference": {
                const view = readFileReference(data);
                renderOpenables(view.title, view.entries);
                return;
            }
            case "data-report-preview": {
                const view = readReportPreview(data);
                renderOpenables(view.title, [view.entry]);
                return;
            }
            case "data-report-preview-failed": {
                const view = readReportPreviewFailed(data);
                sink.out(`\n  [report] ${view.entry.name}: ${view.entry.caption ?? "failed"}\n`);
                return;
            }
            default:
                // Rule 3: observe unknown parts, do not swallow them.
                sink.out(`  [part:${type}]\n`);
                return;
        }
    }

    /** Print a text-shaped presentation inline: markdown source verbatim, code fenced, tables as aligned text. */
    function renderInlinePresentation(title: string | undefined, body: PresentationBody): void {
        if (title) sink.out(`\n  [show] ${title}\n`);
        switch (body.kind) {
            case "markdown":
                sink.out(`${body.body}\n`);
                return;
            case "code":
                sink.out("```" + body.language + "\n" + body.code + "\n```\n");
                return;
            case "table":
                sink.out(`${formatTable(body.headers, body.rows)}\n`);
                if (body.caption) sink.out(`    ${body.caption}\n`);
                return;
            default: {
                const _exhaustive: never = body;
                return _exhaustive;
            }
        }
    }

    /** Print openable entries: one line per entry with the resolved path as an OSC 8 `file://` link (plain path visible). */
    function renderOpenables(title: string | undefined, entries: OpenableEntry[]): void {
        if (title) sink.out(`\n  [show] ${title}\n`);
        for (const entry of entries) {
            if (entry.target.kind === "unavailable") {
                sink.out(`    ${entry.name}: ${entry.caption ?? "unavailable"}\n`);
                continue;
            }
            const path = resolvePath(analysisId, entry.target);
            const suffix = entry.caption ? ` — ${entry.caption}` : "";
            // The visible text stays the raw path; the link TARGET is a percent-encoded `file://` URI
            // (via `pathToFileURL`) so spaces / `#` in the path don't truncate or mangle the OSC 8 target.
            if (path) sink.out(`    ${entry.name}  ${hyperlink(pathToFileURL(path).href, path)}${suffix}\n`);
            else sink.out(`    ${entry.name}  (path unavailable)${suffix}\n`);
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
