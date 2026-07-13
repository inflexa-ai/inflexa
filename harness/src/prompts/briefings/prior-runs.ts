/**
 * Prior-runs briefing — the second standing briefing of the main conversation
 * (see the conversation-briefings spec).
 *
 * `render` is PURE over the `PriorRunsInput` the run-index reader produces
 * (`src/state/run-index.ts`). The content is a lightweight INDEX of the
 * analysis's terminal runs — per run: id, plan title/question, terminal
 * status, step outcomes, completion timestamp — capped at the 10 most recent
 * with an explicit `…and K older runs` line when more exist. It carries NO
 * synthesis body, NO step-summary text, NO findings: it is awareness plus
 * pointers, closing with a fixed nudge that details are retrievable
 * just-in-time via the `inspect_run` tool.
 */

import type { PriorRunEntry, PriorRunsInput } from "../../state/run-index.js";
import type { BriefingDefinition } from "./types.js";

export const PRIOR_RUNS_BRIEFING_NAME = "prior-runs";

/** The fixed closing nudge — always the content's final line. */
const INSPECT_NUDGE = "Details for any run (step summaries, synthesis) are retrievable via the `inspect_run` tool.";

/** Minute-precision timestamp for a run entry; `unknown` on a malformed row. */
function fmtTimestamp(completedAt: string | null): string {
    if (!completedAt) return "unknown";
    return completedAt.slice(0, 16).replace("T", " ");
}

/** Date-only stamp for the at-a-glance caption (e.g. `2026-07-10`). */
function fmtDate(completedAt: string | null): string {
    if (!completedAt) return "unknown";
    return completedAt.slice(0, 10);
}

/** `n/m steps` — the compact step-outcome facet shared by entries and caption. */
function stepFraction(entry: PriorRunEntry): string {
    return `${entry.steps.completed}/${entry.steps.total} steps`;
}

/** The entry's step outcome line facet, including any failed step names. */
function stepOutcome(entry: PriorRunEntry): string {
    if (entry.steps.total === 0) return "no steps recorded";
    const base = `${entry.steps.completed}/${entry.steps.total} steps completed`;
    if (entry.steps.failedStepNames.length === 0) return base;
    return `${base}, failed: ${entry.steps.failedStepNames.join(", ")}`;
}

/** Two lines per run: id + title, then status · outcomes · completion time. */
function renderEntry(entry: PriorRunEntry): string[] {
    return [`- **${entry.runId}** — ${entry.title}`, `  ${entry.status} · ${stepOutcome(entry)} · ${fmtTimestamp(entry.completedAt)}`];
}

function renderContent(input: PriorRunsInput): string {
    const lines: string[] = ["# Prior runs", ""];
    for (const entry of input.entries) {
        lines.push(...renderEntry(entry));
    }
    if (input.olderCount > 0) {
        lines.push("", `…and ${input.olderCount} older run${input.olderCount === 1 ? "" : "s"}`);
    }
    lines.push("", INSPECT_NUDGE);
    return lines.join("\n");
}

function renderCaption(input: PriorRunsInput): string {
    const count = input.entries.length;
    if (count === 0) return "no prior runs";
    const latest = input.entries[0]!;
    return `${count} prior run${count === 1 ? "" : "s"} · latest ${latest.runId} ${stepFraction(latest)} · ${fmtDate(latest.completedAt)}`;
}

export const priorRunsBriefing: BriefingDefinition<PriorRunsInput> = {
    name: PRIOR_RUNS_BRIEFING_NAME,
    description: "An index of the analysis's prior terminal runs and their step outcomes.",
    mode: "standing",
    render(input) {
        return { content: renderContent(input), caption: renderCaption(input) };
    },
};
