import { randomUUIDv7 } from "bun";
import { resolve } from "node:path";
import { ok, err, Result } from "neverthrow";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import type { Str256, IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef, listAnalyses, listAnalysesByAnchor, listAnalysesByProject, listAnalysisInputs } from "../../db/primary_query.ts";
import { insertAnalysis, insertAnalysisInput, updateAnalysis } from "../../db/primary_mutation.ts";
import { getOrCreateAnchorForCwd } from "../anchor/anchor.ts";
import { findMarkerUpwards } from "../anchor/marker.ts";
import { classifyInputPath } from "./input.ts";
import { resolveOutputDir } from "./output.ts";
import { env } from "../../lib/env.ts";

/** Args for {@link createAnalysis}. `name` is validated to {@link Str256} at the CLI boundary. */
export type CreateAnalysisInput = {
    /** Becomes the analysis's home anchor. */
    cwd: string;
    /** Required human label; drives the slug. */
    name: Str256;
    /** Raw input paths; when empty, defaults to the anchor directory itself. */
    inputPaths?: string[];
    /** From `--output`; resolved to absolute and persisted onto `outputDirectory`. */
    outputOverride?: string;
    /** Optional project grouping (the lone foreign key — last). */
    projectId?: string | null;
};

/**
 * Kebab/lowercase a name into a URL-safe slug. A symbol-only name (which slugs to empty) falls back
 * to a generated `analysis-<6 hex>` handle (from a randomUUIDv7 slice) so every analysis still has a
 * stable slug.
 */
export function makeBaseSlug(name: string): string {
    const slug = name
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (slug) return slug;
    return `analysis-${randomUUIDv7().slice(-6).toLowerCase()}`;
}

// Slugs must be unique within the anchor: outputs live at <anchor>/.inflexa/analyses/<slug>/,
// so two analyses sharing an anchor must not share a slug. Suffix -2, -3, … on collision.
function uniqueSlugForAnchor(anchorId: string, name: string): Result<string, DbError> {
    const base = makeBaseSlug(name);
    return listAnalysesByAnchor(anchorId).map((existing) => {
        const taken = new Set(existing.map((a) => a.slug));
        if (!taken.has(base)) return base;
        for (let i = 2; ; i++) {
            const candidate = `${base}-${i}`;
            if (!taken.has(candidate)) return candidate;
        }
    });
}

function refKey(input: AnalysisInput): string {
    return `${input.anchorId ?? ""}|${input.path}`;
}

/**
 * Classify each raw path, de-dup (batch + existing), and reject a non-existent path with a
 * clear error rather than storing a dangling ref.
 */
export function addInputs(analysisId: string, rawPaths: string[], cwd: string): Result<AnalysisInput[], DbError> {
    return listAnalysisInputs(analysisId).andThen((existing) =>
        // Classify every raw path first; the first failure (e.g. a non-existent path)
        // short-circuits so we never store a dangling ref.
        Result.combine(rawPaths.map((raw) => classifyInputPath(analysisId, raw, cwd))).andThen((classified) => {
            const seen = new Set(existing.map(refKey));
            const toInsert: AnalysisInput[] = [];
            for (const input of classified) {
                const key = refKey(input);
                if (seen.has(key)) continue;
                seen.add(key);
                toInsert.push(input);
            }
            return Result.combine(toInsert.map((input) => insertAnalysisInput(input))).map(() => toInsert);
        }),
    );
}

/**
 * Orchestrate analysis creation: anchor → unique slug → insert → inputs → output-dir
 * resolution + fallback persist. Output-dir *creation* is deferred to first chat / `inflexa open`;
 * here we only resolve and persist a stable path.
 */
export function createAnalysis(opts: CreateAnalysisInput): Result<Analysis, DbError> {
    return getOrCreateAnchorForCwd(opts.cwd).andThen((anchor) =>
        uniqueSlugForAnchor(anchor.id, opts.name).andThen((slug) => {
            const now = Date.now();
            const analysis: Analysis = {
                id: randomUUIDv7(),
                projectId: opts.projectId ?? null,
                anchorId: anchor.id,
                name: opts.name,
                slug,
                outputDirectory: opts.outputOverride ? resolve(opts.cwd, opts.outputOverride) : null,
                createdAt: now,
                updatedAt: now,
            };
            const inputPaths = opts.inputPaths && opts.inputPaths.length > 0 ? opts.inputPaths : [anchor.cachedPath];
            return insertAnalysis(analysis)
                .andThen((created) => addInputs(created.id, inputPaths, opts.cwd).map(() => created))
                .andThen((created) =>
                    resolveOutputDir(created).andThen((outDir) => {
                        // Persist only the XDG fallback (case 3); a writable-anchor path (case 2)
                        // stays null = derived, and an override is already absolute on the row.
                        if (created.outputDirectory === null && outDir.startsWith(env.outputFallbackDir)) {
                            const persisted: Analysis = { ...created, outputDirectory: outDir };
                            return updateAnalysis(persisted).map(() => persisted);
                        }
                        return ok(created);
                    }),
                );
        }),
    );
}

/** Analyses anchored at the nearest marker for `dir`; empty when there is no marker. */
export function listAnalysesForAnchorAt(dir: string): Result<Analysis[], DbError> {
    let found: ReturnType<typeof findMarkerUpwards>;
    try {
        found = findMarkerUpwards(dir);
    } catch (cause) {
        return err({ type: "query_failed", op: "listAnalysesForAnchorAt:marker", cause });
    }
    if (!found) return ok([]);
    return listAnalysesByAnchor(found.marker.anchorId);
}

/** All analyses, or those for `opts.projectId` when given — most-recent-first. */
export function listRecentAnalyses(opts?: { projectId?: string }): Result<Analysis[], DbError> {
    if (opts?.projectId) return listAnalysesByProject(opts.projectId);
    return listAnalyses();
}

/** The resolution of an id-or-name ref: the best match, plus any other analyses sharing the matched name/slug. */
export type AnalysisMatch = {
    /** The resolved analysis — an exact id hit if any, else the most-recent name/slug hit. */
    analysis: Analysis;
    /** Other analyses sharing the matched name/slug (empty when the match was by id, or the name was unique). */
    others: Analysis[];
};

/**
 * Resolve an id-or-name ref in a single query: exact id wins, else the most-recent slug/name
 * hit, with any same-name siblings surfaced as `others` so the caller can flag ambiguity.
 * `null` when nothing matches.
 */
export function matchAnalysis(ref: IdOrName): Result<AnalysisMatch | null, DbError> {
    return findAnalysesByRef(ref).map((rows): AnalysisMatch | null => {
        const [best, ...rest] = rows;
        if (!best) return null;
        // An exact-id hit is unique; only a slug/name hit can have collisions.
        return { analysis: best, others: best.id === ref ? [] : rest };
    });
}

/** Resolve an id-or-name ref to one analysis (exact id first, else most-recent slug/name); `null` when none match. Ambiguity is the caller's to surface via {@link matchAnalysis}. */
export function findAnalysis(ref: IdOrName): Result<Analysis | null, DbError> {
    return matchAnalysis(ref).map((m) => m?.analysis ?? null);
}
