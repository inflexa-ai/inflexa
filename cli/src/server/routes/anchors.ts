import { Hono } from "hono";
import { errAsync } from "neverthrow";
import { z } from "zod";

import { describeBusyReason, type BusyReason } from "../../api/analyses.ts";
import type { DeadAnchorView, PruneAnchorsResponse, RelocateAnchorResponse, RepairAnchorResponse, SkippedAnchorView } from "../../api/anchors.ts";
import { getLogger } from "../../lib/log.ts";
import {
    analysesOfAnchors,
    findDeadAnchors,
    reclaimDeadAnchors,
    relocateAnchor,
    relocateAnchorPrefix,
    repairAnchorAt,
    type PurgeAnalysisFn,
} from "../../modules/anchor/backstop.ts";
import { analysisPurgeFor } from "../../modules/harness/purge.ts";
import type { HarnessRuntime } from "../../modules/harness/runtime.ts";
import type { ServerBoot } from "../boot.ts";
import { workspaceBusyReasons } from "../busy_gate.ts";
import { apiError, internalError, readBody, type ServerEnv } from "../http.ts";
import { absolutePath } from "./analyses.ts";

/** What the anchor routes read beyond SQLite and the disk. Tests replace each one. */
export type AnchorRouteOpts = {
    /** The busy gate of the workspace folder of one analysis. A prune keeps an anchor with a busy analysis. */
    readonly busyReasons: (analysisId: string, runtime: HarnessRuntime | null) => Promise<BusyReason[]>;
    /** The purge of the Postgres footprint of an analysis, over the pool of the booted runtime. */
    readonly purgeFor: (runtime: HarnessRuntime) => PurgeAnalysisFn;
};

/** The production {@link AnchorRouteOpts}. */
export const DEFAULT_ANCHOR_ROUTE_OPTS: AnchorRouteOpts = {
    busyReasons: (analysisId, runtime) => workspaceBusyReasons(analysisId, runtime),
    // Through the per-pool memo: the booted pool outlives each prune, and an adapter for each prune would
    // leave handlers on it that nothing takes back off (see `analysisPurgeFor`).
    purgeFor: (runtime) => (analysisId) => analysisPurgeFor(runtime.pool).purgeAnalysis(analysisId),
};

const repairBody = z.object({ path: absolutePath });

const relocateBody = z.union([
    z.object({ fromPath: absolutePath, toPath: absolutePath, dryRun: z.boolean().optional() }),
    z.object({ from: absolutePath, to: absolutePath, dryRun: z.boolean().optional() }),
]);

const pruneBody = z.object({ dryRun: z.boolean().optional(), anchorIds: z.array(z.string()).optional(), cwd: absolutePath.optional() });

/**
 * The routes under `/api/v1/anchors` (draft 6.1): the manual backstop for a moved or a deleted folder. A
 * repair and a relocation touch SQLite and the disk only. A prune that must purge an analysis needs the
 * runtime, for the pool of the server.
 */
export function anchorRoutes(boot: ServerBoot, opts: AnchorRouteOpts = DEFAULT_ANCHOR_ROUTE_OPTS): Hono<ServerEnv> {
    const routes = new Hono<ServerEnv>();

    routes.post("/repair", async (c) => {
        const body = await readBody(c, repairBody);
        if (body.isErr()) return body.error;
        return repairAnchorAt(body.value.path).match(
            (outcome) => c.json(outcome satisfies RepairAnchorResponse),
            (e) => {
                switch (e.type) {
                    case "no_marker":
                        return apiError(c, "not_found", `No marker at ${e.dir}. Nothing to repair.`);
                    case "no_anchor_row":
                        return apiError(c, "not_found", `Marker ${e.anchorId} has no anchor row; cannot repair.`);
                    case "marker_unreadable":
                        return apiError(c, "conflict", `Could not read the marker at ${e.dir} (corrupt?).`);
                    case "db_failed":
                        return internalError(c, e.cause, "repair the anchor");
                    default: {
                        const exhaustive: never = e;
                        throw new Error(`unhandled repair error: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
        );
    });

    routes.post("/relocate", async (c) => {
        const body = await readBody(c, relocateBody);
        if (body.isErr()) return body.error;
        const dryRun = body.value.dryRun ?? false;
        if ("fromPath" in body.value) {
            return relocateAnchor(body.value.fromPath, body.value.toPath, { dryRun }).match(
                (outcome) => c.json({ dryRun, ...outcome } satisfies RelocateAnchorResponse),
                (e) =>
                    e.type === "not_tracked"
                        ? apiError(c, "not_found", `No anchor is tracked at ${e.path}.`)
                        : internalError(c, e.cause, "relocate the anchor"),
            );
        }
        return relocateAnchorPrefix(body.value.from, body.value.to, { dryRun }).match(
            (outcome) => c.json({ dryRun, ...outcome } satisfies RelocateAnchorResponse),
            (e) => internalError(c, e, "relocate the anchors under a prefix"),
        );
    });

    routes.post("/prune", async (c) => {
        const body = await readBody(c, pruneBody);
        if (body.isErr()) return body.error;
        const found = findDeadAnchors(body.value.cwd === undefined ? undefined : [body.value.cwd]);
        if (found.isErr()) return internalError(c, found.error, "find the dead anchors");
        const wanted = body.value.anchorIds === undefined ? null : new Set(body.value.anchorIds);
        const selected = found.value.filter((a) => wanted === null || wanted.has(a.id));
        const listed = analysesOfAnchors(selected);
        if (listed.isErr()) return internalError(c, listed.error, "list the analyses of the dead anchors");
        const analysesByAnchor = new Map(listed.value.map((l) => [l.anchorId, l.analysisIds]));
        const dead = selected.map((a): DeadAnchorView => ({ anchorId: a.id, path: a.cachedPath, analysisCount: analysesByAnchor.get(a.id)?.length ?? 0 }));
        if (body.value.dryRun) return c.json({ dryRun: true, dead, pruned: [], skipped: [], purged: 0 } satisfies PruneAnchorsResponse);

        // An anchor is deleted as a unit with its analyses, thus one busy analysis keeps the whole anchor.
        const runtime = boot.runtime();
        const skipped: SkippedAnchorView[] = [];
        for (const anchor of selected) {
            for (const analysisId of analysesByAnchor.get(anchor.id) ?? []) {
                const reasons = await opts.busyReasons(analysisId, runtime);
                if (reasons.length > 0) {
                    skipped.push({ anchorId: anchor.id, analysisId, reasons });
                    break;
                }
            }
        }
        const skippedIds = new Set(skipped.map((s) => s.anchorId));
        const prunable = selected.filter((a) => !skippedIds.has(a.id));
        const needsPurge = prunable.some((a) => (analysesByAnchor.get(a.id)?.length ?? 0) > 0);
        if (needsPurge && runtime === null) {
            return apiError(
                c,
                "unavailable",
                "The harness runtime is not ready, and these anchors hold analyses whose conversations and run history live in its database. Nothing was pruned.",
                { phase: boot.state().phase },
            );
        }

        // With no runtime, no anchor of `prunable` holds an analysis (the 503 above), thus no purge is called.
        const purge: PurgeAnalysisFn =
            runtime === null
                ? () => errAsync({ type: "connection_failed", op: "prune:no_runtime", cause: "the harness runtime is not ready" })
                : opts.purgeFor(runtime);
        return (await reclaimDeadAnchors(prunable, purge, (analysisId) => opts.busyReasons(analysisId, runtime))).match(
            ({ purged }) => c.json({ dryRun: false, dead, pruned: prunable.map((a) => a.id), skipped, purged } satisfies PruneAnchorsResponse),
            (e) => {
                switch (e.type) {
                    case "sqlite_failed":
                        return internalError(c, e.cause, "delete the rows of the dead anchors");
                    case "busy":
                        // `reasons[0]!`: the reclaim gives `busy` only for a gate answer that is not empty.
                        return apiError(
                            c,
                            "busy",
                            `Cannot prune while ${describeBusyReason(e.reasons[0]!)} in analysis ${e.analysisId} — nothing was pruned. Run \`inflexa prune\` again: it keeps the anchor of a busy analysis.`,
                            { analysisId: e.analysisId, reasons: e.reasons },
                        );
                    case "purge_failed":
                        getLogger("server").error({ err: e.cause, analysisId: e.analysisId }, "could not purge an analysis of a dead anchor");
                        return apiError(
                            c,
                            "internal_error",
                            `Could not reclaim the conversations and run history of analysis ${e.analysisId} — nothing was pruned, so nothing was lost. Run \`inflexa prune\` again once the cause is fixed.`,
                        );
                    default: {
                        const exhaustive: never = e;
                        throw new Error(`unhandled prune error: ${JSON.stringify(exhaustive)}`);
                    }
                }
            },
        );
    });

    return routes;
}
