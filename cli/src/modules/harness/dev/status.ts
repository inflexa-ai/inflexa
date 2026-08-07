import { createPool, loadDataProfileStatus, type Pool } from "@inflexa-ai/harness";

import { fail, type Spinner } from "../../../lib/cli.ts";
import { resolvePostgresConfig } from "../../../lib/config.ts";
import { activeHarnessRuntime } from "../runtime.ts";

// How the two blocking dev commands narrate a wait, and how the two `--status` views reach the
// ledger. `inflexa profile` and `inflexa run` both start a workflow inside THIS process's DBOS
// runtime and then block to a terminal state, so both want the same two things: the newest step of
// the running workflow, and a pool for a read-only view that must never boot anything.
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
 * read from `dbos.operation_outputs`. Generalized so both the profile wait (below)
 * and the run wait (`run.ts`) share one reader: the caller supplies a scalar
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

/**
 * Latest step of the newest profile workflow for this analysis, read from the
 * DBOS step record. Returns `null` on any miss or error: progress is a
 * cosmetic channel, and a hiccup here must never abort a live run's wait.
 */
async function readRunProgress(pool: Pool, analysisId: string): Promise<{ step: number; label: string } | null> {
    return readNewestWorkflowStep(pool, {
        text: `SELECT workflow_uuid FROM dbos.workflow_status
                 WHERE workflow_uuid LIKE 'dataprofile:' || $1 || ':%'
                 ORDER BY created_at DESC LIMIT 1`,
        values: [analysisId],
    });
}

/** Human-readable elapsed time since `sinceMs`, e.g. `2m05s` or `42s`. Shared with the run wait. */
export function formatElapsed(sinceMs: number): string {
    const total = Math.floor((Date.now() - sinceMs) / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/** Poll the ledger until the run leaves `running`, narrating progress on the spinner. */
export async function waitForTerminalStatus(pool: Pool, analysisId: string, s: Spinner): Promise<{ status: string; error: string | null }> {
    const startedAt = Date.now();
    for (;;) {
        const status = (await loadDataProfileStatus(pool, analysisId)).match(
            (st) => st,
            (e) => {
                s.error("Lost the ledger connection");
                return fail("Lost the ledger connection while waiting", e);
            },
        );
        // The row was seeded before triggering, so null here means it was
        // deleted underneath us — treat as failure rather than spinning.
        if (status === null) return { status: "failed", error: "ledger row disappeared" };
        if (status.status !== "running" && status.status !== "pending") {
            return { status: status.status, error: status.error };
        }
        if (status.status === "pending") {
            s.message(`Profiling — waiting for the run to start · ${formatElapsed(startedAt)}`);
        } else {
            const progress = await readRunProgress(pool, analysisId);
            s.message(
                progress ? `Profiling — ${progress.label} · step ${progress.step} · ${formatElapsed(startedAt)}` : `Profiling · ${formatElapsed(startedAt)}`,
            );
        }
        await Promise.sleep(2000);
    }
}

/**
 * Run `fn` against the harness ledger pool for a read-only `--status` view, then
 * clean up. Reuses the booted runtime's pool when THIS process owns one, else
 * opens a throwaway connection to an already-running Postgres and drains it after.
 * Never boots or provisions — a status view is pure observation. `hasRuntime`
 * tells `fn` whether a runtime is live here, which the views use to annotate a
 * `running` row (a row with no local runtime is owned elsewhere or recovering).
 *
 * Shared by `inflexa profile --status` and `inflexa run --status` — the acquire
 * and throwaway-drain are identical, so they live here once rather than once per
 * command.
 */
export async function withStatusPool<T>(fn: (pool: Pool, hasRuntime: boolean) => Promise<T>): Promise<T> {
    const runtime = activeHarnessRuntime();
    let pool: Pool | null = runtime?.pool ?? null;
    let throwaway = false;
    if (!pool) {
        const conn = resolvePostgresConfig();
        pool = createPool({ host: conn.host, port: String(conn.port), database: conn.database, user: conn.user, password: conn.password, sslMode: "disable" });
        throwaway = true;
    }

    try {
        return await fn(pool, runtime !== null);
    } finally {
        if (throwaway && pool) {
            await pool.end().catch(() => {
                // Read-only convenience connection; a failed drain must not fail the command.
            });
        }
    }
}
