/**
 * The Run Activity record of a chat turn. The render holds no time of the call, thus a set of runs
 * that does not change gives byte-identical text, and the turn stores no new record.
 */

import type { RunPage } from "../state/runs.js";

/** Maximum detailed run rows paid into every conversation turn. */
export const RUN_ACTIVITY_DETAIL_LIMIT = 20;

function renderRows(label: string, rows: RunPage["runs"]): string[] {
    if (rows.length === 0) return [];
    return [`${label}:`, ...rows.map((run) => `- runId: ${run.runId} | planId: ${run.planId ?? "none"} | startedAt: ${run.startedAt}`)];
}

/** Render the bounded run-activity snapshot of a conversation turn. */
export function renderRunActivity(activity: RunPage): string {
    const lines = ["[Run Activity]"];
    if (activity.total === 0) {
        lines.push("No runs are currently running or suspended.");
        return lines.join("\n");
    }

    const running = activity.runs.filter((run) => run.status === "running");
    const suspended = activity.runs.filter((run) => run.status === "suspended_insufficient_funds");
    lines.push(...renderRows("Running", running), ...renderRows("Suspended", suspended));

    const omitted = activity.total - activity.runs.length;
    if (omitted > 0) {
        lines.push(`Showing ${activity.runs.length} of ${activity.total} non-terminal runs; ${omitted} omitted. Use inspect_run to page the full list.`);
    }
    return lines.join("\n");
}

/** Render an honest degraded state when the activity projection cannot be read. */
export function renderRunActivityUnavailable(): string {
    return "[Run Activity]\nRun status is temporarily unavailable. Do not infer that no active runs exist.";
}
