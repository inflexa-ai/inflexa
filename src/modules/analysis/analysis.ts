import { randomUUIDv7 } from "bun";
import { resolve, sep } from "node:path";
import { ok, Result } from "neverthrow";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import type { Str256, IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef, listAnalyses, listAnalysesByAnchor, listAnalysesByProject, listAnalysisInputs } from "../../db/primary_query.ts";
import { insertAnalysis, insertAnalysisInput, deleteAnalysisInput, updateAnalysis } from "../../db/primary_mutation.ts";
import { currentUserActor } from "../prov/prov.ts";
import { Bus } from "../../lib/bus.ts";
import { getOrCreateAnchorForCwd } from "../anchor/anchor.ts";
import { findMarkerUpwards } from "../anchor/marker.ts";
import { classifyInputPath } from "./input.ts";
import { resolveOutputDir, defaultOutputSubdir } from "./output.ts";
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

/** The first analysis in `candidates` whose output dir contains `path` (a true path-boundary match), or null. */
export function matchOutputPrefix(path: string, candidates: { id: string; dir: string }[]): string | null {
    for (const c of candidates) {
        // Boundary match only: `dir` exactly, or `dir` followed by a separator — so `…/a-extra` does
        // not match output dir `…/a` (the same guard relocateRawInputPrefix uses).
        if (path === c.dir || path.startsWith(c.dir + sep)) return c.id;
    }
    return null;
}

/**
 * Detect whether `input` is itself another inflexa analysis's output, returning that analysis's id
 * (to record as `derivedFromAnalysisId`, linking the two provenance documents) or null.
 *
 * Side-effect-FREE by design: uses only pure reads (`listAnalysesByAnchor`/`listAnalyses`), never
 * `resolveOutputDir`/`resolveAnchor` — whose Step-1 `touchAnchor` would bump every other anchor's
 * `last_seen` on each add, a false "sighting" that corrupts the heartbeat. Two cases are provable
 * from stored data alone:
 *  - an anchor-relative input under a sibling's DEFAULT output (`<anchor>/.inflexa/analyses/<slug>/`):
 *    same anchor, so its stored relpath is prefixed by that analysis's default output subdir;
 *  - a raw absolute input under some analysis's EXPLICIT `outputDirectory`.
 * Not detected (best-effort, per the "if possible" spec): XDG-fallback outputs, and a default output
 * reached from a different anchor than the input's own.
 */
export function detectSourceAnalysis(input: AnalysisInput, excludeAnalysisId: string): Result<string | null, DbError> {
    if (input.anchorId !== null) {
        const anchorId = input.anchorId;
        return listAnalysesByAnchor(anchorId).map((siblings) =>
            matchOutputPrefix(
                input.path,
                siblings.filter((a) => a.id !== excludeAnalysisId && a.outputDirectory === null).map((a) => ({ id: a.id, dir: defaultOutputSubdir(a.slug) })),
            ),
        );
    }
    return listAnalyses().map((all) =>
        matchOutputPrefix(
            input.path,
            // Only analyses that pinned an explicit (absolute) output dir; a raw input's path is absolute too.
            all.flatMap((a) => (a.id !== excludeAnalysisId && a.outputDirectory !== null ? [{ id: a.id, dir: a.outputDirectory }] : [])),
        ),
    );
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
            // Emit each add onto the provenance chain (actor resolved once for the batch); the recorder
            // appends it to the analysis's PROV document. When an input is itself another analysis's
            // output, `derivedFromAnalysisId` links the two documents (detection is side-effect-free —
            // see detectSourceAnalysis).
            const actor = currentUserActor();
            return Result.combine(
                toInsert.map((input) =>
                    insertAnalysisInput(input).andThen(() =>
                        detectSourceAnalysis(input, analysisId).map((sourceId) => {
                            Bus.emit("inflexa", {
                                type: "prov.input_added",
                                analysisId: input.analysisId,
                                actor,
                                input,
                                derivedFromAnalysisId: sourceId,
                            });
                        }),
                    ),
                ),
            ).map(() => toInsert);
        }),
    );
}

/**
 * Remove a single input ref and record the removal in the analysis's provenance chain. Returns the
 * removed input, or `null` when no matching ref existed (nothing removed, nothing to record).
 */
export function removeInput(input: AnalysisInput): Result<AnalysisInput | null, DbError> {
    return deleteAnalysisInput(input).map((changed) => {
        if (changed === 0) return null;
        Bus.emit("inflexa", {
            type: "prov.input_removed",
            analysisId: input.analysisId,
            actor: currentUserActor(),
            input,
        });
        return input;
    });
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
            return (
                insertAnalysis(analysis)
                    // Seed the provenance document with the creation event before any input events.
                    .andThen((created) => {
                        Bus.emit("inflexa", {
                            type: "prov.analysis_created",
                            analysisId: created.id,
                            actor: currentUserActor(),
                        });
                        return ok(created);
                    })
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
                    )
            );
        }),
    );
}

/** Analyses anchored at the nearest marker for `dir`; empty when there is no marker. */
export function listAnalysesForAnchorAt(dir: string): Result<Analysis[], DbError> {
    return findMarkerUpwards(dir)
        .mapErr((cause): DbError => ({ type: "query_failed", op: "listAnalysesForAnchorAt:marker", cause }))
        .andThen((found) => (found ? listAnalysesByAnchor(found.marker.anchorId) : ok([])));
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
