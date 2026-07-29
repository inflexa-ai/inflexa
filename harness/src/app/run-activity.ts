/**
 * Ephemeral conversation-tail projection of non-terminal analysis runs.
 *
 * This is derived operational state, not memory: callers render it afresh for
 * each turn and never persist it to the thread.
 */

import type { RunPage } from "../state/runs.js";

/** Maximum detailed run rows paid into every conversation turn. */
export const RUN_ACTIVITY_DETAIL_LIMIT = 20;

function compactAge(startedAt: string, nowMs: number): string {
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return "unknown age";

    const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1_000));
    if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
    const elapsedHours = Math.floor(elapsedMinutes / 60);
    if (elapsedHours < 24) return `${elapsedHours}h ago`;
    return `${Math.floor(elapsedHours / 24)}d ago`;
}

function renderRows(label: string, rows: RunPage["runs"], nowMs: number): string[] {
    if (rows.length === 0) return [];
    return [
        `${label}:`,
        ...rows.map(
            (run) => `- runId: ${run.runId} | planId: ${run.planId ?? "none"} | startedAt: ${run.startedAt} | started: ${compactAge(run.startedAt, nowMs)}`,
        ),
    ];
}

/** Render the bounded run-activity snapshot injected into a conversation tail. */
export function renderRunActivity(activity: RunPage, nowMs = Date.now()): string {
    const lines = ["[Run Activity]"];
    if (activity.total === 0) {
        lines.push("No runs are currently running or suspended.");
        return lines.join("\n");
    }

    const running = activity.runs.filter((run) => run.status === "running");
    const suspended = activity.runs.filter((run) => run.status === "suspended_insufficient_funds");
    lines.push(...renderRows("Running", running, nowMs), ...renderRows("Suspended", suspended, nowMs));

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
