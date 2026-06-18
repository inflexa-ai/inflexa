import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Result } from "neverthrow";
import type { AnchorMarker } from "../../types/anchor.ts";
import { confirm, dieOn, fail } from "../../lib/cli.ts";
import { countAnalysesByAnchor, getAnchor, listAnchors } from "../../db/primary_query.ts";
import { deleteAnalysesForAnchor, deleteAnchor, relocateRawInputPrefix, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
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
    try {
        return readMarker(dir);
    } catch {
        return null;
    }
}

/**
 * `inf repair [path]` — sync the anchor whose marker sits at `path` (default cwd) back to
 * that path. The marker travelled with the folder, so its on-disk identity is the truth;
 * the stored `cachedPath` is the stale hint we correct.
 */
export function runRepair(path?: string): void {
    const dir = canonicalPath(path ?? process.cwd());

    let marker: AnchorMarker | null;
    try {
        marker = readMarker(dir);
    } catch (cause) {
        fail(`Could not read the marker at ${dir} (corrupt?):`, cause);
    }
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

/** Args for `inf relocate`: a single `<fromPath> <toPath>` pair, or a `--from`/`--to` prefix sweep. */
type RelocateArgs = { fromPath?: string; toPath?: string; from?: string; to?: string };

/**
 * `inf relocate <fromPath> <toPath>` (one anchor) or `inf relocate --from <prefix> --to
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
    fail("Usage: inf relocate <from-path> <to-path>   OR   inf relocate --from <prefix> --to <prefix>");
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
 * `inf prune` — drop anchors whose folders are confirmed gone. "Confirmed" means three
 * things together: the anchor had an on-disk marker, its cached folder no longer exists,
 * and reconciliation cannot re-find it. A transient or relocatable miss is never pruned.
 */
export async function runPrune(): Promise<void> {
    const anchors = listAnchors().match((a) => a, dieOn("Failed to list anchors"));

    const dead = anchors.filter((a) => {
        if (!a.markerWritten) return false;
        if (existsSync(a.cachedPath)) return false;
        const refound = resolveAnchor(a.id).match(
            (r) => r.path,
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

    // The analyses→anchors FK has no ON DELETE CASCADE, so delete each dead anchor's analyses
    // (their input refs cascade via the analysis FK) before dropping the anchor itself.
    Result.combine(dead.map((a) => deleteAnalysesForAnchor(a.id).andThen(() => deleteAnchor(a.id)))).match(
        () => console.log(`Pruned ${dead.length} anchor(s).`),
        (error) => fail(`Failed to prune: ${error.type}`, error.cause),
    );
}
