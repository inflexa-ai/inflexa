import { Hono, type Context } from "hono";
import { ok, Result } from "neverthrow";
import { z } from "zod";

import type { UsageGroup, UsageGrouping, UsageView } from "../../api/usage.ts";
import type { DbError } from "../../db/errors.ts";
import {
    getAnalysisDataProfileUsageTotals,
    getAnalysisUnattributedUsageTotals,
    getAnalysisUsageTotals,
    getSessionUsageTotalsIncludingRuns,
    listAnalysisUsageByAgent,
    listAnalysisUsageByModel,
    listAnalysisUsageByRun,
    listAnalysisUsageBySession,
    listRunUsageByStep,
    listSessionUsageByAgent,
    listSessionUsageByModel,
    type LlmUsageByRun,
} from "../../db/primary_query.ts";
import { apiError, internalError, type ServerEnv } from "../http.ts";

const usageQuery = z.object({
    threadId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    by: z.enum(["model", "agent", "thread", "run", "step"]).optional(),
});

/**
 * The route `GET {A}/usage` (draft 2.5): the usage ledger of the analysis, read from SQLite only, thus it
 * needs no runtime. One request gives the totals of one scope and at most one grouping:
 *
 * - no `threadId` and no `runId` — the analysis, with the data profile and the unattributed calls
 * - `threadId` — one conversation, with each run that it started (the sidebar USAGE figure)
 * - `runId` — one run, matched by its full id or by a trailing part of one (`inflexa usage steps`)
 */
export function usageRoutes(): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.get("/", (c) => {
        const analysisId = c.req.param("analysisId");
        if (analysisId === undefined) return apiError(c, "not_found", "No analysis in the path.");
        const parsed = usageQuery.safeParse(c.req.query());
        if (!parsed.success) return apiError(c, "validation_error", "A query value is not correct.", z.flattenError(parsed.error));
        const { threadId, runId, by } = parsed.data;
        if (threadId !== undefined && runId !== undefined) return apiError(c, "validation_error", "Send `threadId` or `runId`, not both.");
        if (threadId !== undefined) return threadUsage(c, analysisId, threadId, by);
        if (runId !== undefined) return runUsage(c, analysisId, runId, by);
        return analysisUsage(c, analysisId, by);
    });

    return routes;
}

/** 400 for a grouping that the scope has no ledger read for. */
function unsupportedGrouping(c: Context, scope: string, by: UsageGrouping): Response {
    return apiError(c, "validation_error", `The ${scope} usage has no grouping \`by=${by}\`.`);
}

function analysisUsage(c: Context, analysisId: string, by: UsageGrouping | undefined): Response {
    if (by === "step") return apiError(c, "validation_error", "`by=step` needs the run in `runId`.");
    const groups = (): Result<UsageGroup[] | undefined, DbError> => {
        switch (by) {
            case undefined:
                return ok(undefined);
            case "model":
                return listAnalysisUsageByModel(analysisId).map((gs) => gs.map((g) => ({ key: g.servedModelId, totals: g.totals })));
            case "agent":
                return listAnalysisUsageByAgent(analysisId).map((gs) => gs.map((g) => ({ key: g.agentId, totals: g.totals })));
            case "thread":
                return listAnalysisUsageBySession(analysisId).map((gs) => gs.map((g) => ({ key: g.threadId, totals: g.totals })));
            case "run":
                return listAnalysisUsageByRun(analysisId).map((gs) => gs.map((g) => ({ key: g.runId, totals: g.totals })));
            default: {
                const exhaustive: never = by;
                throw new Error(`unhandled usage grouping: ${String(exhaustive)}`);
            }
        }
    };
    return Result.combine([getAnalysisUsageTotals(analysisId), getAnalysisDataProfileUsageTotals(analysisId), getAnalysisUnattributedUsageTotals(analysisId)])
        .andThen(([totals, dataProfile, unattributed]) =>
            groups().map((gs): UsageView => ({ scope: { kind: "analysis" }, totals, grains: { dataProfile, unattributed }, ...(gs ? { groups: gs } : {}) })),
        )
        .match(
            (view) => c.json(view),
            (e) => internalError(c, e, "read the usage of the analysis"),
        );
}

function threadUsage(c: Context, analysisId: string, threadId: string, by: UsageGrouping | undefined): Response {
    if (by !== undefined && by !== "model" && by !== "agent") return unsupportedGrouping(c, "conversation", by);
    const groups = (): Result<UsageGroup[] | undefined, DbError> => {
        if (by === "model") return listSessionUsageByModel(analysisId, threadId).map((gs) => gs.map((g) => ({ key: g.servedModelId, totals: g.totals })));
        if (by === "agent") return listSessionUsageByAgent(analysisId, threadId).map((gs) => gs.map((g) => ({ key: g.agentId, totals: g.totals })));
        return ok(undefined);
    };
    return getSessionUsageTotalsIncludingRuns(analysisId, threadId)
        .andThen((totals) => groups().map((gs): UsageView => ({ scope: { kind: "thread", threadId }, totals, ...(gs ? { groups: gs } : {}) })))
        .match(
            (view) => c.json(view),
            (e) => internalError(c, e, "read the usage of a conversation"),
        );
}

/** A run id with its dashes removed: the space that a trailing abbreviation matches in. */
function bareId(id: string): string {
    return id.replace(/-/g, "");
}

/**
 * The runs of the analysis with recorded usage that `ref` names: the run with that exact id, else each run
 * whose id ends with `ref`. The id tail is what the sidebar and the usage dialog print, thus a reader has
 * the tail, not the full id. The candidates are the runs with ledger rows, the same aggregate that the
 * report reads, thus the match costs no extra query.
 */
function matchRuns(runs: readonly LlmUsageByRun[], ref: string): LlmUsageByRun[] {
    const exact = runs.find((r) => r.runId === ref);
    if (exact) return [exact];
    const tail = bareId(ref);
    return tail.length > 0 ? runs.filter((r) => bareId(r.runId).endsWith(tail)) : [];
}

function runUsage(c: Context, analysisId: string, ref: string, by: UsageGrouping | undefined): Response {
    if (by !== undefined && by !== "step") return unsupportedGrouping(c, "run", by);
    return listAnalysisUsageByRun(analysisId).match(
        (runs) => {
            const candidates = matchRuns(runs, ref);
            const [run] = candidates;
            if (run === undefined) return apiError(c, "not_found", `No usage recorded for run "${ref}".`);
            // Two runs' steps in one table would be wrong in a way that nothing on the screen shows, thus
            // an abbreviation that names two runs is refused, with each full id to choose from.
            if (candidates.length > 1) {
                const list = candidates.map((r) => `  ${r.runId}`).join("\n");
                return apiError(c, "conflict", `Ambiguous run "${ref}" — ${candidates.length} runs match:\n${list}`, {
                    candidates: candidates.map((r) => r.runId),
                });
            }
            if (by === undefined) return c.json({ scope: { kind: "run", runId: run.runId }, totals: run.totals } satisfies UsageView);
            return listRunUsageByStep(analysisId, run.runId).match(
                (steps) =>
                    c.json({
                        scope: { kind: "run", runId: run.runId },
                        totals: run.totals,
                        groups: steps.map((g) => ({ key: g.stepId, totals: g.totals })),
                    } satisfies UsageView),
                (e) => internalError(c, e, "read the usage of the steps of a run"),
            );
        },
        (e) => internalError(c, e, "read the usage of the runs"),
    );
}
