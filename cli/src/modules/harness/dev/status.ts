import type { Pool } from "@inflexa-ai/harness";

// How the blocking `inflexa run --plan` narrates its wait: it starts a workflow inside THIS process's
// DBOS runtime and then blocks to a terminal state, so it wants the newest step of the running
// workflow.
//
// It sits in `dev/` because nothing outside `dev/` reads any of it. The TUI activity panel
// deliberately does NOT — `tui/hooks/activity_panel.ts` records why: the step cache records a step
// only when that step RETURNS, so its newest row names whatever finished last, never the work in
// flight. The panel takes the event stream instead. These readers are correct for a coarse
// spinner line and wrong for a live panel, and that is the whole reason they are dev-only.

/**
 * Human label for a DBOS step name from the profile workflow's step record —
 * the progress channel's vocabulary. Best-effort: unknown names pass through
 * verbatim so new step kinds surface instead of hiding behind a generic label.
 */
export function friendlyStepLabel(functionName: string): string {
    const llm = functionName.match(/^llm-(\d+)$/);
    if (llm) return `model round ${Number(llm[1]) + 1}`;
    if (functionName.startsWith("tool-")) {
        const rest = functionName.slice("tool-".length);
        // Step names are `tool-{toolName}-{toolCallId}` with toolCallId minted
        // as `toolu_…`; tool names themselves may contain hyphens/underscores.
        const cut = rest.lastIndexOf("-toolu");
        return `tool ${cut === -1 ? rest : rest.slice(0, cut)}`;
    }
    if (functionName.includes("submit-exec")) return "dispatching sandbox command";
    if (functionName === "DBOS.recv" || functionName === "DBOS.sleep" || functionName === "DBOS.now") return "sandbox executing";
    return functionName;
}

/**
 * Latest DBOS step of the NEWEST workflow selected by `selectNewestWorkflowUuid`,
 * read from `dbos.operation_outputs`. The caller (the run wait, `run.ts`) supplies a scalar
 * subquery resolving to the target `workflow_uuid` (its `$N` params bind against
 * `values`), and this wraps it in the fixed newest-step projection. Returns `null`
 * on any miss or error — progress is a cosmetic channel and a hiccup here must
 * never abort a live wait.
 */
export async function readNewestWorkflowStep(
    pool: Pool,
    selectNewestWorkflowUuid: { text: string; values: unknown[] },
): Promise<{ step: number; label: string } | null> {
    try {
        const result = await pool.query<{ function_id: number; function_name: string }>({
            text: `SELECT oo.function_id, oo.function_name
             FROM dbos.operation_outputs oo
             WHERE oo.workflow_uuid = (${selectNewestWorkflowUuid.text})
             ORDER BY oo.function_id DESC LIMIT 1`,
            values: selectNewestWorkflowUuid.values,
        });
        const row = result.rows[0];
        if (!row) return null;
        return { step: Number(row.function_id) + 1, label: friendlyStepLabel(row.function_name) };
    } catch {
        return null;
    }
}

/**
 * The scalar subquery selecting a run's newest workflow — the parent
 * (`workflow_uuid = runId`) or one of its children (`runId-N`) — for
 * {@link readNewestWorkflowStep}. A UUID contains no LIKE wildcards, so the
 * pattern is literal apart from the trailing `%`.
 *
 * The headless run wait (`run.ts`) is the one caller, and the file header says
 * why no product surface joins it. It stays a named function rather than an
 * inline literal because the `runId-N` child-id scheme is a contract with the
 * harness's workflow naming: one named site is where a reader looks when that
 * scheme changes, and an inline copy at the call site reads as a local detail.
 */
export function runWorkflowFamily(runId: string): { text: string; values: unknown[] } {
    return {
        text: `SELECT workflow_uuid FROM dbos.workflow_status
                 WHERE workflow_uuid = $1 OR workflow_uuid LIKE $1 || '-%'
                 ORDER BY created_at DESC LIMIT 1`,
        values: [runId],
    };
}

/** Human-readable elapsed time since `sinceMs`, e.g. `2m05s` or `42s`, for the run wait. */
export function formatElapsed(sinceMs: number): string {
    const total = Math.floor((Date.now() - sinceMs) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
