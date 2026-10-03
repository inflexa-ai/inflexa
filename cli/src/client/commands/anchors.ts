import { confirm, fail } from "../../lib/cli.ts";
import { expandAndResolve } from "../../lib/paths.ts";
import { DEFAULT_CLIENT_OPTS, describeClientError, type ClientError, type ClientOpts } from "../api.ts";
import { pruneAnchors, relocateAnchor, repairAnchor } from "../anchors.ts";

// The anchor backstop commands as clients of the local server: `repair`, `relocate`, and `prune`. Each
// path of the user resolves against the folder of THIS process before it goes to the server. A command
// that asks for a confirmation sends a dry run first, then the change.

/** Print the client error and exit: the end of each command on a failed request. */
function failClient(e: ClientError): never {
    return fail(describeClientError(e));
}

/** `inflexa repair [path]` — point the anchor of the marker at `path` (default: this folder) back at that folder. */
export async function anchorRepair(path: string | undefined, opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const outcome = (await repairAnchor({ path: expandAndResolve(process.cwd(), path ?? ".") }, opts)).match((v) => v, failClient);
    if (outcome.outcome === "unchanged") console.log(`Anchor ${outcome.anchorId} already points at ${outcome.after}. Nothing to repair.`);
    else console.log(`Repaired anchor ${outcome.anchorId}\n  before: ${outcome.before}\n  after:  ${outcome.after}`);
}

/**
 * `inflexa relocate <fromPath> <toPath>` (one anchor) or `inflexa relocate --from <prefix> --to <prefix>`
 * (each anchor under a moved tree). Unlike `repair`, this forces the new path even when no marker followed
 * the folder.
 */
export async function anchorRelocate(
    args: { fromPath?: string; toPath?: string; from?: string; to?: string },
    opts: ClientOpts = DEFAULT_CLIENT_OPTS,
): Promise<void> {
    const cwd = process.cwd();
    if (args.from && args.to) {
        const from = expandAndResolve(cwd, args.from);
        const to = expandAndResolve(cwd, args.to);
        const preview = (await relocateAnchor({ from, to, dryRun: true }, opts)).match((v) => v, failClient);
        if (preview.relocated.length === 0) {
            console.log(`No anchors under ${from}. Nothing to relocate.`);
            return;
        }
        console.log(`Will rewrite ${preview.relocated.length} anchor path(s):\n  ${from}  ->  ${to}`);
        if (!(await confirm("Apply?"))) {
            console.log("Cancelled.");
            return;
        }
        const applied = (await relocateAnchor({ from, to }, opts)).match((v) => v, failClient);
        console.log(`Rewrote ${applied.relocated.length} anchor path(s) and ${applied.rawInputs} raw input path(s).`);
        return;
    }
    if (args.fromPath && args.toPath) {
        const fromPath = expandAndResolve(cwd, args.fromPath);
        const toPath = expandAndResolve(cwd, args.toPath);
        const preview = (await relocateAnchor({ fromPath, toPath, dryRun: true }, opts)).match((v) => v, failClient);
        // The anchor expected an on-disk marker, but the target carries none for it (lost, or never
        // written). The new path is still valid — the confirmation keeps a mistyped path from silently
        // stranding the identity.
        if (preview.markerMissing && !(await confirm(`${preview.relocated[0]?.after ?? toPath} has no marker for this anchor. Re-point anyway?`))) {
            console.log("Cancelled.");
            return;
        }
        const applied = (await relocateAnchor({ fromPath, toPath }, opts)).match((v) => v, failClient);
        for (const r of applied.relocated) console.log(`Relocated anchor ${r.anchorId}\n  before: ${r.before}\n  after:  ${r.after}`);
        return;
    }
    fail("Usage: inflexa relocate <from-path> <to-path>   OR   inflexa relocate --from <prefix> --to <prefix>");
}

/**
 * `inflexa prune` — drop the anchors whose folders are confirmed gone, and purge their analyses. The
 * confirmation covers the anchors of the dry run only: the prune names them, thus an anchor whose folder
 * goes after the preview is not taken.
 */
export async function anchorPrune(opts: ClientOpts = DEFAULT_CLIENT_OPTS): Promise<void> {
    const preview = (await pruneAnchors({ dryRun: true }, opts)).match((v) => v, failClient);
    if (preview.dead.length === 0) {
        console.log("Nothing to prune.");
        return;
    }
    console.log(`Found ${preview.dead.length} anchor(s) whose folders are gone:`);
    for (const a of preview.dead) console.log(`  ${a.anchorId}  ${a.path}  (${a.analysisCount} analyses)`);
    if (!(await confirm("Delete these anchors and their analyses?"))) {
        console.log("Cancelled.");
        return;
    }
    const outcome = (await pruneAnchors({ anchorIds: preview.dead.map((a) => a.anchorId) }, opts)).match((v) => v, failClient);
    console.log(`Pruned ${outcome.pruned.length} anchor(s).`);
    if (outcome.purged > 0) console.log(`  Reclaimed ${outcome.purged} analysis(es) from Postgres.`);
    for (const s of outcome.skipped)
        console.log(`  Kept anchor ${s.anchorId}: work holds analysis ${s.analysisId} (${s.reasons.join(", ")}). Run \`inflexa prune\` again later.`);
}
