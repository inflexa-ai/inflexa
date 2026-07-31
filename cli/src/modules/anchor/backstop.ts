import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { err, Result, type ResultAsync } from "neverthrow";
import { createAnalysisPurge, createDbosWorkflowPurger, createPool } from "@inflexa-ai/harness";
// The harness's Postgres error union, aliased so it never reads as the SQLite `DbError` this file also
// carries — the two are different stores with different recoveries, and a prune abort has to name which.
import type { AnalysisPurgeOutcome, DbError as PgError, Pool } from "@inflexa-ai/harness";
import type { Anchor, AnchorMarker } from "../../types/anchor.ts";
import { confirm, dieOn, fail } from "../../lib/cli.ts";
import type { DbError } from "../../db/errors.ts";
import { countAnalysesByAnchor, getAnchor, listAnalysesByAnchor, listAnchors } from "../../db/primary_query.ts";
import { deleteAnalysesForAnchor, deleteAnchor, relocateRawInputPrefix, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
import { ensurePostgresReady } from "../infra/postgres.ts";
import type { PostgresConnection, PostgresError } from "../infra/postgres_types.ts";
import { canonicalPath, readMarker } from "./marker.ts";
import { resolveAnchor } from "./anchor.ts";

// The explicit move backstop. `resolveAnchor` already self-heals a moved folder
// automatically on the next lookup (cached-path → cwd/ancestor → bounded search); these
// commands are the manual fallback for what reconciliation cannot settle on its own — a
// folder moved while you were elsewhere, an ambiguous multi-match, or a path-only anchor
// whose marker never made the trip. They are addressed by filesystem path, never by an
// analysis: re-pointing a folder's identity is the anchor's job, and an anchor outlives
// any analysis that happens to be homed in it.

/** Read a marker, treating corruption as "absent" — these commands only need presence/identity. */
function readMarkerSafe(dir: string): AnchorMarker | null {
    return readMarker(dir).unwrapOr(null);
}

/**
 * `inflexa repair [path]` — sync the anchor whose marker sits at `path` (default cwd) back to
 * that path. The marker travelled with the folder, so its on-disk identity is the truth;
 * the stored `cachedPath` is the stale hint we correct.
 */
export function runRepair(path?: string): void {
    const dir = canonicalPath(path ?? process.cwd());

    const markerResult = readMarker(dir);
    if (markerResult.isErr()) fail(`Could not read the marker at ${dir} (corrupt?):`, markerResult.error);
    const marker = markerResult.value;
    if (!marker) fail(`No marker at ${dir}. Nothing to repair.`);
    const anchorId = marker.anchorId;

    getAnchor(anchorId).match((anchor) => {
        if (!anchor) fail(`Marker ${anchorId} has no anchor row; cannot repair.`);
        const before = anchor.cachedPath;
        if (before === dir) {
            console.log(`Anchor ${anchorId} already points at ${dir}. Nothing to repair.`);
            return;
        }
        updateAnchorCachedPath(anchorId, dir).match(
            () => console.log(`Repaired anchor ${anchorId}\n  before: ${before}\n  after:  ${dir}`),
            (error) => fail(`Failed to repair: ${error.type}`, error.cause),
        );
    }, dieOn("Failed to look up anchor"));
}

/** Args for `inflexa relocate`: a single `<fromPath> <toPath>` pair, or a `--from`/`--to` prefix sweep. */
type RelocateArgs = { fromPath?: string; toPath?: string; from?: string; to?: string };

/**
 * `inflexa relocate <fromPath> <toPath>` (one anchor) or `inflexa relocate --from <prefix> --to
 * <prefix>` (every anchor under a moved tree). Unlike `repair`, this forces the new path
 * even when no marker followed the folder — the case `repair` cannot cover.
 */
export async function runRelocate(args: RelocateArgs): Promise<void> {
    if (args.from && args.to) {
        await relocatePrefix(args.from, args.to);
        return;
    }
    if (args.fromPath && args.toPath) {
        await relocateOne(args.fromPath, args.toPath);
        return;
    }
    fail("Usage: inflexa relocate <from-path> <to-path>   OR   inflexa relocate --from <prefix> --to <prefix>");
}

/** Re-point the single anchor currently tracked at `fromPath` to `toPath`. */
async function relocateOne(fromPath: string, toPath: string): Promise<void> {
    const from = canonicalPath(fromPath);
    const to = canonicalPath(toPath);

    const anchors = listAnchors().match((a) => a, dieOn("Failed to list anchors"));
    const anchor = anchors.find((a) => a.cachedPath === from);
    if (!anchor) fail(`No anchor is tracked at ${from}.`);

    // The anchor expected an on-disk marker, but the target carries none for it (lost, or
    // never written). Re-pointing is still valid — confirm so a fat-fingered path can't
    // silently strand the identity.
    const targetMarker = readMarkerSafe(to);
    if (anchor.markerWritten && targetMarker?.anchorId !== anchor.id) {
        if (!(await confirm(`${to} has no marker for this anchor. Re-point anyway?`))) {
            console.log("Cancelled.");
            return;
        }
    }

    updateAnchorCachedPath(anchor.id, to).match(
        () => console.log(`Relocated anchor ${anchor.id}\n  before: ${from}\n  after:  ${to}`),
        (error) => fail(`Failed to relocate: ${error.type}`, error.cause),
    );
}

/** Rewrite the path prefix of every anchor under a moved tree (`fromPrefix` → `toPrefix`). */
async function relocatePrefix(fromPrefix: string, toPrefix: string): Promise<void> {
    // Textual `resolve`, not `canonicalPath`: a relocated source no longer exists to
    // realpath, and stored cached paths are already canonical, so we match on the prefix.
    const fromP = resolve(fromPrefix);
    const toP = resolve(toPrefix);

    const anchors = listAnchors().match((a) => a, dieOn("Failed to list anchors"));
    const affected = anchors.filter((a) => a.cachedPath === fromP || a.cachedPath.startsWith(fromP + sep));

    if (affected.length === 0) {
        console.log(`No anchors under ${fromP}. Nothing to relocate.`);
        return;
    }

    console.log(`Will rewrite ${affected.length} anchor path(s):\n  ${fromP}  ->  ${toP}`);
    if (!(await confirm("Apply?"))) {
        console.log("Cancelled.");
        return;
    }

    // Anchor-relative inputs already ride their anchor's reconciled location; only raw
    // absolute input paths under this prefix need a direct rewrite.
    Result.combine(affected.map((a) => updateAnchorCachedPath(a.id, toP + a.cachedPath.slice(fromP.length))))
        .andThen(() => relocateRawInputPrefix(fromP, toP))
        .match(
            (rawCount) => console.log(`Rewrote ${affected.length} anchor path(s) and ${rawCount} raw input path(s).`),
            (error) => fail(`Failed to relocate prefix: ${error.type}`, error.cause),
        );
}

/**
 * Why a confirmed prune stopped. Whatever the cause, `inflexa prune` is its own recovery: the folders
 * are still gone, so a re-run selects the same anchors, and the purge is idempotent, so re-reaching an
 * analysis already reclaimed costs nothing.
 *
 * The two failures raised before the SQLite stage — `postgres_unavailable` and `purge_failed` — leave
 * every anchor and analysis row present, which is what lets the abort notice say nothing was lost.
 * `sqlite_failed` carries no such guarantee once the deletes have begun: they are combined over an
 * eagerly-built array, so each anchor's pair runs whether or not an earlier one failed, and some rows
 * can already be gone. That is not a state to repair — those analyses were purged before any row was
 * touched, so nothing is orphaned, and the next run simply finishes the deletes.
 */
export type PruneError =
    | { type: "postgres_unavailable"; cause: PostgresError }
    | { type: "purge_failed"; analysisId: string; cause: PgError }
    | { type: "sqlite_failed"; cause: DbError };

/**
 * Injectable edges for the prune's reclaim stage, so its ORDER is assertable offline — no container
 * engine, no Postgres. Order is the whole contract here (see {@link reclaimDeadAnchors}), and a suite
 * that only proved each stage ran would stay green with the stages swapped, which is precisely the
 * arrangement that strands every footprint. Production callers omit the argument.
 */
export type PruneSeams = {
    /**
     * Bring the container stack up and hand back the connection. Real: {@link ensurePostgresReady},
     * which STARTS a stopped stack rather than refusing — a maintenance command is most often run
     * because the environment is already in a bad state.
     */
    readonly ensurePostgres: () => Promise<Result<PostgresConnection, PostgresError>>;
    /** Open a pool onto the provisioned connection. Real: the harness's `createPool`. */
    readonly openPool: (conn: PostgresConnection) => Pool;
    /** Reclaim one analysis's Postgres footprint. Real: `createAnalysisPurge` over the opened pool. */
    readonly purgeAnalysis: (pool: Pool, analysisId: string) => ResultAsync<AnalysisPurgeOutcome, PgError>;
    /** Release the pool this command opened. Real: `pool.end()`. */
    readonly drainPool: (pool: Pool) => Promise<void>;
};

const realPruneSeams: PruneSeams = {
    ensurePostgres: ensurePostgresReady,
    openPool: (conn) =>
        createPool({ host: conn.host, port: String(conn.port), database: conn.database, user: conn.user, password: conn.password, sslMode: "disable" }),
    // Built per prune over the pool this command opened: the purger is a thin adapter over that pool,
    // so there is nothing to keep alive beyond it.
    purgeAnalysis: (pool, analysisId) => createAnalysisPurge({ pool, workflows: createDbosWorkflowPurger({ pool }) }).purgeAnalysis(analysisId),
    drainPool: (pool) =>
        pool.end().catch(() => {
            // The reclaim is already decided by the time this runs, so a connection that will not close
            // cleanly must not turn a completed prune into a failed one.
        }),
};

/**
 * Reclaim the dead anchors' Postgres footprints, then delete their SQLite rows. Exported so the order
 * below is drivable without a container engine; {@link runPrune} is the production caller and only
 * reaches here once the user has confirmed.
 *
 * The purge runs for EVERY analysis before ANY SQLite delete, because those rows carry the only copy
 * of the analysis ids and the purge is addressed by id alone. Deleting them first would strand every
 * one of those footprints beyond the reach of any retry — in bulk, and while reporting success, since
 * nothing would be left to name what was orphaned. Prune is the path most likely to meet many analyses
 * at once, which is exactly what makes the wrong order expensive here.
 *
 * A failure before the deletes returns with every row still present. Once the deletes begin, some
 * anchors can already be gone — they are combined over an eagerly-built array, so an early failure
 * does not stop the rest, and each pair is independent of every other. Neither shape is a partial
 * success to be tidied up later: every analysis was purged before any row was touched, the folders are
 * still gone, and the purge is idempotent, so re-running the command is the whole recovery.
 */
export async function reclaimDeadAnchors(dead: readonly Anchor[], seams: PruneSeams = realPruneSeams): Promise<Result<void, PruneError>> {
    const listed = Result.combine(dead.map((a) => listAnalysesByAnchor(a.id)));
    if (listed.isErr()) return err({ type: "sqlite_failed", cause: listed.error });
    const analysisIds = listed.value.flat().map((a) => a.id);

    // Provisioning is attempted only after the ids are in hand, so a stack that cannot start costs
    // nothing but the attempt — and it is attempted at all (rather than refused) because prune is
    // maintenance: the stack being down is a common REASON to run it, not a reason to block it.
    const provisioned = await seams.ensurePostgres();
    if (provisioned.isErr()) return err({ type: "postgres_unavailable", cause: provisioned.error });

    const pool = seams.openPool(provisioned.value);
    try {
        // Sequential, and it stops at the first failure: a purge that cannot complete means the rest of
        // this prune must not proceed, and naming the analysis it stopped on is what makes the abort
        // notice actionable.
        for (const analysisId of analysisIds) {
            const purged = await seams.purgeAnalysis(pool, analysisId);
            if (purged.isErr()) return err({ type: "purge_failed", analysisId, cause: purged.error });
        }
        // The analyses→anchors FK has no ON DELETE CASCADE, so each dead anchor's analyses go first
        // (their input refs cascade via the analysis FK) and the anchor itself after.
        return Result.combine(dead.map((a) => deleteAnalysesForAnchor(a.id).andThen(() => deleteAnchor(a.id))))
            .map(() => undefined)
            .mapErr((cause): PruneError => ({ type: "sqlite_failed", cause }));
    } finally {
        await seams.drainPool(pool);
    }
}

/** The abort message for a stopped prune, phrased so the user learns what survived and what to do next. */
function describePruneAbort(error: PruneError): string {
    switch (error.type) {
        case "postgres_unavailable":
            return `Could not start Postgres, where these analyses' conversations and run history live — nothing was pruned, so nothing was lost.\n  ${error.cause.message}\n  Fix that, then run \`inflexa prune\` again.`;
        case "purge_failed":
            return `Could not reclaim analysis ${error.analysisId}'s conversations and run history (${error.cause.type}) — nothing was pruned, so nothing was lost. Run \`inflexa prune\` again once the cause is fixed.`;
        case "sqlite_failed":
            return `Failed to prune: ${error.cause.type}`;
    }
}

/**
 * `inflexa prune` — drop anchors whose folders are confirmed gone. "Confirmed" means three
 * things together: the anchor had an on-disk marker, its cached folder no longer exists,
 * and reconciliation cannot re-find it. A transient or relocatable miss is never pruned.
 *
 * Confirmation buys BOTH stores: each dead anchor's analyses have their Postgres footprint reclaimed
 * before any SQLite row goes (see {@link reclaimDeadAnchors}). Prune boots no harness runtime, so the
 * pool it needs comes from the provisioning gate and is drained again when the command ends.
 */
export async function runPrune(): Promise<void> {
    const anchors = listAnchors().match((a) => a, dieOn("Failed to list anchors"));

    const dead = anchors.filter((a) => {
        if (!a.markerWritten) return false;
        if (existsSync(a.cachedPath)) return false;
        const refound = resolveAnchor(a.id).match(
            (r) => r?.path ?? null,
            () => null,
        );
        return refound === null;
    });

    if (dead.length === 0) {
        console.log("Nothing to prune.");
        return;
    }

    console.log(`Found ${dead.length} anchor(s) whose folders are gone:`);
    for (const a of dead) {
        const count = countAnalysesByAnchor(a.id).match(
            (n) => n,
            () => 0,
        );
        console.log(`  ${a.id}  ${a.cachedPath}  (${count} analyses)`);
    }
    if (!(await confirm("Delete these anchors and their analyses?"))) {
        console.log("Cancelled.");
        return;
    }

    (await reclaimDeadAnchors(dead)).match(
        () => console.log(`Pruned ${dead.length} anchor(s).`),
        (error) => fail(describePruneAbort(error), error.type === "sqlite_failed" ? error.cause.cause : undefined),
    );
}
