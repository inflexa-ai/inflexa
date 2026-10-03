import { existsSync } from "node:fs";
import { sep } from "node:path";
import { err, ok, Result, type ResultAsync } from "neverthrow";
// The harness's Postgres error union, aliased so it never reads as the SQLite `DbError` this file also
// carries — the two are different stores with different recoveries, and a prune abort has to name which.
import type { AnalysisPurgeOutcome, DbError as PgError } from "@inflexa-ai/harness";
import type { Anchor } from "../../types/anchor.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnchor, listAnalysesByAnchor, listAnchors } from "../../db/primary_query.ts";
import { deleteAnalysesForAnchor, deleteAnchor, relocateRawInputPrefix, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { readMarker, type MarkerError } from "./marker.ts";
import { resolveAnchor } from "./anchor.ts";

// The explicit move backstop. `resolveAnchor` already self-heals a moved folder
// automatically on the next lookup (cached-path → cwd/ancestor → bounded search); these
// operations are the manual fallback for what reconciliation cannot settle on its own — a
// folder moved while you were elsewhere, an ambiguous multi-match, or a path-only anchor
// whose marker never made the trip. They are addressed by filesystem path, never by an
// analysis: re-pointing a folder's identity is the anchor's job, and an anchor outlives
// any analysis that happens to be homed in it. The local server serves them
// (`/api/v1/anchors/*`), and the `repair`, `relocate`, and `prune` commands are its clients.

/** Why a repair could not run. */
export type RepairError =
    | { type: "marker_unreadable"; dir: string; cause: MarkerError }
    | { type: "no_marker"; dir: string }
    | { type: "no_anchor_row"; anchorId: string }
    | { type: "db_failed"; cause: DbError };

/** What a repair did: the anchor of the marker now points at `after`, which it maybe did before. */
export type RepairOutcome = { outcome: "repaired" | "unchanged"; anchorId: string; before: string; after: string };

/**
 * Sync the anchor whose marker sits at `path` back to that path. The marker travelled with the folder, so
 * its on-disk identity is the truth; the stored `cachedPath` is the stale hint this corrects.
 */
export function repairAnchorAt(path: string): Result<RepairOutcome, RepairError> {
    const dir = canonicalPath(path);
    const marker = readMarker(dir);
    if (marker.isErr()) return err({ type: "marker_unreadable", dir, cause: marker.error });
    if (marker.value === null) return err({ type: "no_marker", dir });
    const anchorId = marker.value.anchorId;

    return getAnchor(anchorId)
        .mapErr((cause): RepairError => ({ type: "db_failed", cause }))
        .andThen((anchor): Result<RepairOutcome, RepairError> => {
            if (anchor === null) return err({ type: "no_anchor_row", anchorId });
            const before = anchor.cachedPath;
            if (before === dir) return ok({ outcome: "unchanged", anchorId, before, after: dir });
            return updateAnchorCachedPath(anchorId, dir)
                .map((): RepairOutcome => ({ outcome: "repaired", anchorId, before, after: dir }))
                .mapErr((cause): RepairError => ({ type: "db_failed", cause }));
        });
}

/** One anchor that a relocation points at a new path. */
export type Relocation = { anchorId: string; before: string; after: string };

/** What a relocation did, or would do with `dryRun`. */
export type RelocateOutcome = {
    relocated: Relocation[];
    /** The absolute input paths that a prefix relocation rewrote. */
    rawInputs: number;
    /** One folder only: the anchor wrote a marker, but the target holds no marker of it. */
    markerMissing: boolean;
};

/** Why a relocation of one folder could not run. */
export type RelocateError = { type: "not_tracked"; path: string } | { type: "db_failed"; cause: DbError };

/**
 * Re-point the single anchor tracked at `fromPath` to `toPath`. Unlike a repair, this forces the new path
 * even when no marker followed the folder — the case a repair cannot cover. `markerMissing` tells the
 * caller to confirm first, so a mistyped path cannot silently strand the identity.
 */
export function relocateAnchor(fromPath: string, toPath: string, opts: { dryRun: boolean }): Result<RelocateOutcome, RelocateError> {
    const from = canonicalPath(fromPath);
    const to = canonicalPath(toPath);
    return listAnchors()
        .mapErr((cause): RelocateError => ({ type: "db_failed", cause }))
        .andThen((anchors): Result<RelocateOutcome, RelocateError> => {
            const anchor = anchors.find((a) => a.cachedPath === from);
            if (!anchor) return err({ type: "not_tracked", path: from });
            const targetMarker = readMarker(to).unwrapOr(null);
            const outcome: RelocateOutcome = {
                relocated: [{ anchorId: anchor.id, before: from, after: to }],
                rawInputs: 0,
                markerMissing: anchor.markerWritten && targetMarker?.anchorId !== anchor.id,
            };
            if (opts.dryRun) return ok(outcome);
            return updateAnchorCachedPath(anchor.id, to)
                .map(() => outcome)
                .mapErr((cause): RelocateError => ({ type: "db_failed", cause }));
        });
}

/**
 * Rewrite the path prefix of each anchor under a moved tree. Both prefixes are absolute, and they match
 * textually: a moved source no longer exists to canonicalize, and the stored cached paths are already
 * canonical. Anchor-relative inputs ride their anchor; only the absolute input paths under the prefix need
 * a direct rewrite.
 */
export function relocateAnchorPrefix(fromPrefix: string, toPrefix: string, opts: { dryRun: boolean }): Result<RelocateOutcome, DbError> {
    return listAnchors().andThen((anchors) => {
        const affected = anchors.filter((a) => a.cachedPath === fromPrefix || a.cachedPath.startsWith(fromPrefix + sep));
        const relocated = affected.map((a): Relocation => ({ anchorId: a.id, before: a.cachedPath, after: toPrefix + a.cachedPath.slice(fromPrefix.length) }));
        if (opts.dryRun || relocated.length === 0) return ok({ relocated, rawInputs: 0, markerMissing: false });
        return Result.combine(relocated.map((r) => updateAnchorCachedPath(r.anchorId, r.after)))
            .andThen(() => relocateRawInputPrefix(fromPrefix, toPrefix))
            .map((rawInputs): RelocateOutcome => ({ relocated, rawInputs, markerMissing: false }));
    });
}

/**
 * The anchors whose folders are confirmed gone. "Confirmed" means three things together: the anchor had
 * an on-disk marker, its cached folder no longer exists, and reconciliation cannot find it again. A
 * transient or relocatable miss is never selected.
 */
export function findDeadAnchors(): Result<Anchor[], DbError> {
    return listAnchors().map((anchors) =>
        anchors.filter((a) => {
            if (!a.markerWritten) return false;
            if (existsSync(a.cachedPath)) return false;
            const refound = resolveAnchor(a.id).match(
                (r) => r?.path ?? null,
                () => null,
            );
            return refound === null;
        }),
    );
}

/**
 * Why a prune stopped. The prune is its own recovery: the folders are still gone, so a new run selects
 * the same anchors, and the purge is idempotent, so a second purge of an analysis costs nothing.
 *
 * `purge_failed` comes before the SQLite stage, thus each anchor and analysis row is still present.
 * `sqlite_failed` carries no such guarantee once the deletes begin: they are combined over an
 * eagerly-built array, so each anchor's pair runs whether or not an earlier one failed, and some rows can
 * already be gone. That is not a state to repair — those analyses were purged before any row was touched,
 * so nothing is orphaned, and the next run finishes the deletes.
 */
export type PruneError = { type: "purge_failed"; analysisId: string; cause: PgError } | { type: "sqlite_failed"; cause: DbError };

/** What a completed prune did in Postgres: the count of the purged analyses. */
export type PruneReclaim = {
    readonly purged: number;
};

/** Reclaim the Postgres footprint of one analysis. The server passes the purge over its own pool. */
export type PurgeAnalysisFn = (analysisId: string) => ResultAsync<AnalysisPurgeOutcome, PgError>;

/**
 * The ids of the analyses homed at each of `dead`. The caller reads them before the prune: the busy gate
 * keeps an anchor whose analysis has work, and a purge needs a booted runtime.
 */
export function analysesOfAnchors(dead: readonly Anchor[]): Result<{ anchorId: string; analysisIds: string[] }[], DbError> {
    return Result.combine(dead.map((a) => listAnalysesByAnchor(a.id).map((analyses) => ({ anchorId: a.id, analysisIds: analyses.map((x) => x.id) }))));
}

/**
 * Reclaim the dead anchors' Postgres footprints, then delete their SQLite rows.
 *
 * The purge runs for EVERY analysis before ANY SQLite delete, because those rows carry the only copy of
 * the analysis ids and the purge is addressed by id alone. Deleting them first would strand each of those
 * footprints beyond the reach of any retry — in bulk, and while reporting success, since nothing would be
 * left to name what was orphaned. Prune is the path most likely to meet many analyses at once, which is
 * exactly what makes the wrong order expensive here.
 *
 * An anchor that held no analyses has no Postgres footprint, thus `purge` is never called for it.
 */
export async function reclaimDeadAnchors(dead: readonly Anchor[], purge: PurgeAnalysisFn): Promise<Result<PruneReclaim, PruneError>> {
    const listed = analysesOfAnchors(dead);
    if (listed.isErr()) return err({ type: "sqlite_failed", cause: listed.error });
    const analysisIds = listed.value.flatMap((a) => a.analysisIds);

    // Sequential, and it stops at the first failure: a purge that cannot complete means the rest of this
    // prune must not proceed, and naming the analysis it stopped on makes the abort actionable.
    for (const analysisId of analysisIds) {
        const purged = await purge(analysisId);
        if (purged.isErr()) return err({ type: "purge_failed", analysisId, cause: purged.error });
    }

    // The analyses→anchors FK has no ON DELETE CASCADE, so each dead anchor's analyses go first (their
    // input refs cascade via the analysis FK) and the anchor itself after.
    return Result.combine(dead.map((a) => deleteAnalysesForAnchor(a.id).andThen(() => deleteAnchor(a.id))))
        .map(() => ({ purged: analysisIds.length }))
        .mapErr((cause): PruneError => ({ type: "sqlite_failed", cause }));
}
