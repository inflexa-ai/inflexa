import { errorMessageOf } from "../lib/thrown.js";
import { textOf } from "../lib/unknown-text.js";

import type { Logger } from "../lib/logger.js";
import { formatQuery, parseQuery, type PackageQuery } from "../sandbox/package-identity.js";
import type { CheckedPackage } from "./sandbox/list-available-packages.js";

/**
 * A package entry that the step does not carry.
 *
 * - `unparsable` — the entry is not a query of the one grammar.
 * - `absent` — the bound resolution answered that the pool holds no such
 *   package, and it offered no other spelling.
 */
export type DroppedPackage = {
    readonly entry: string;
    readonly reason: "unparsable" | "absent";
};

/**
 * A targeted presence check of the names of an ad hoc step. `null` means that
 * the inventory could not answer at all, and every parsed entry then stays — an
 * unreadable inventory says nothing about a package.
 */
export type ResolvePackages = (names: readonly string[]) => Promise<readonly CheckedPackage[] | null>;

/** The spelling that the pool holds for a missed entry, where the resolution offers one. */
function suggestedSpelling(rows: readonly CheckedPackage[]): string | undefined {
    for (const row of rows) {
        if (!row.present && row.suggestion !== undefined) return row.suggestion;
    }
    return undefined;
}

/**
 * Validate the package entries of an ad hoc step on their own axis: a bad entry
 * costs that entry and nothing else, because the step is sound without it.
 *
 * A guess of a model reaches here, and no person reviewed it. Thus a name that
 * the pool does not hold leaves the step with a caveat, where the same name in
 * a plan step — which a person approved — refuses the launch instead.
 */
export async function validateAdHocPackages(
    entries: readonly string[],
    resolve: ResolvePackages | undefined,
    logger: Logger,
): Promise<{ packages: string[]; droppedPackages: DroppedPackage[] }> {
    const droppedPackages: DroppedPackage[] = [];
    const kept: { entry: string; query: PackageQuery }[] = [];
    const seen = new Set<string>();
    for (const element of entries) {
        const entry = element.trim();
        const parsed = parseQuery(entry);
        if (parsed.isErr()) {
            droppedPackages.push({ entry, reason: "unparsable" });
            continue;
        }
        // Two equal entries are one ask, and the link pass unions them anyway.
        if (seen.has(entry)) continue;
        seen.add(entry);
        kept.push({ entry, query: parsed.value });
    }
    const asWritten = (): string[] => kept.map((candidate) => candidate.entry);
    if (!resolve || kept.length === 0) return { packages: asWritten(), droppedPackages };

    let rows: readonly CheckedPackage[] | null;
    try {
        rows = await resolve(asWritten());
    } catch (error) {
        // A resolution that throws is the same condition as an inventory that
        // reports itself unavailable: it says nothing about the packages.
        logger.warn("ad hoc package resolution failed", { error: errorMessageOf(error) ?? textOf(error) });
        rows = null;
    }
    if (rows === null) return { packages: asWritten(), droppedPackages };

    const packages: string[] = [];
    const emitted = new Set<string>();
    for (const { entry, query } of kept) {
        // One name that both tracks hold answers with one row per track, thus a
        // present row anywhere in the answer keeps the entry as it was written.
        // The link pass then refuses the bare form with the two prefixed ones.
        const answer = rows.filter((row) => row.requested === entry);
        const held = answer.length === 0 || answer.some((row) => row.present);
        const suggestion = held ? undefined : suggestedSpelling(answer);
        if (!held && suggestion === undefined) {
            droppedPackages.push({ entry, reason: "absent" });
            continue;
        }
        // The track and the version of the ask survive the rewrite: only the
        // spelling missed, and the entry asked for that exact pin.
        const resolved = suggestion === undefined ? entry : formatQuery({ ...query, spelling: suggestion });
        // A rewrite can land on the spelling that another entry already carries,
        // thus the answer dedupes as well as the input: `r:seurat` and
        // `r:SEURAT` are one ask once both take the spelling that the pool holds.
        if (emitted.has(resolved)) continue;
        emitted.add(resolved);
        packages.push(resolved);
    }
    return { packages, droppedPackages };
}
