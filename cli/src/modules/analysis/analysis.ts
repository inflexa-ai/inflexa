import { randomUUIDv7 } from "bun";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { err, ok, Result } from "neverthrow";
import type { Analysis, AnalysisInput } from "../../types/analysis.ts";
import type { Str256, IdOrName } from "../../lib/types.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef, listAnalysesByAnchor, listAnalysesByProject, listAnalysisInputs, listAnalyses } from "../../db/primary_query.ts";
import { insertAnalysis, insertAnalysisInput, deleteAnalysisInput, renameAnalysis } from "../../db/primary_mutation.ts";
import { currentUserActor } from "../prov/prov.ts";
import { Bus } from "../../lib/bus.ts";
import { renameResult } from "../../lib/fs.ts";
import { getOrCreateAnchorForCwd, resolveAnchor } from "../anchor/anchor.ts";
import { findMarkerUpwards, isDirWritable } from "../anchor/marker.ts";
import { classifyInputPath } from "./input.ts";
import { defaultOutputSubdir, type WorkspaceError } from "./output.ts";

/** Args for {@link createAnalysis}. `name` is validated to {@link Str256} at the CLI boundary. */
export type CreateAnalysisInput = {
    /** Becomes the analysis's home anchor. Must be writable — the workspace lives under it. */
    cwd: string;
    /** Required human label; drives the slug. */
    name: Str256;
    /** Raw input paths to enroll. Omitted/empty ⇒ the analysis starts with NO inputs — never defaults to cwd; inputs are user-driven. */
    inputPaths?: string[];
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
export function uniqueSlugForAnchor(anchorId: string, name: string): Result<string, DbError> {
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
 * Side-effect-FREE by design: uses only pure reads (`listAnalysesByAnchor`), never
 * `resolveOutputDir`/`resolveAnchor` — whose Step-1 `touchAnchor` would bump every other anchor's
 * `last_seen` on each add, a false "sighting" that corrupts the heartbeat. One case is provable
 * from stored data alone: an anchor-relative input under a sibling's workspace
 * (`<anchor>/.inflexa/analyses/<slug>/`) — same anchor, so its stored relpath is prefixed by that
 * analysis's workspace subdir. Not detected (best-effort, per the "if possible" spec): a raw
 * absolute input under some analysis's workspace, which is only reachable through that analysis's
 * anchor path — a resolution this function must not perform.
 */
export function detectSourceAnalysis(input: AnalysisInput, excludeAnalysisId: string): Result<string | null, DbError> {
    if (input.anchorId !== null) {
        const anchorId = input.anchorId;
        return listAnalysesByAnchor(anchorId).map((siblings) =>
            matchOutputPrefix(
                input.path,
                siblings.filter((a) => a.id !== excludeAnalysisId).map((a) => ({ id: a.id, dir: defaultOutputSubdir(a.slug) })),
            ),
        );
    }
    // A raw absolute input can only sit under some analysis's workspace via that analysis's
    // anchor path — which this function must not resolve (side-effect-free constraint above).
    // Best-effort per the spec: the anchorless case detects nothing.
    return ok(null);
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

/** One failed leg of {@link applyInputsDiff} — which operation failed and the underlying error. */
export type InputsDiffFailure = { op: "add" | "remove"; error: DbError };

/**
 * Apply a picker-style set diff to an analysis's inputs. The adds land first as one
 * all-or-nothing batch ({@link addInputs} short-circuits on the first bad path), and the
 * removals run ONLY when that batch succeeded — otherwise a single vanished pick would
 * reject every add while the removals still stripped the unchecked rows, leaving the
 * analysis with fewer inputs than either the before or the after state. Removal failures
 * are collected rather than short-circuited: each removal is independent, so the
 * survivors should still land. Returns the failures (empty = the whole diff applied).
 */
export function applyInputsDiff(analysisId: string, toAdd: string[], toRemove: AnalysisInput[], cwd: string): InputsDiffFailure[] {
    const failures: InputsDiffFailure[] = [];
    if (toAdd.length > 0) {
        addInputs(analysisId, toAdd, cwd).match(
            () => {},
            (error) => failures.push({ op: "add", error }),
        );
    }
    if (failures.length > 0) return failures;
    for (const input of toRemove) {
        removeInput(input).match(
            () => {},
            (error) => failures.push({ op: "remove", error }),
        );
    }
    return failures;
}

/**
 * Orchestrate analysis creation: writability precondition → anchor → unique slug → insert →
 * inputs. The workspace root is always derived (anchor + slug), never persisted; its *creation*
 * is deferred to first chat / `inflexa open`. Writability is checked BEFORE any row or marker
 * write: the workspace at `<cwd>/.inflexa/analyses/<slug>/` is where everything the analysis
 * touches will live, so a folder that cannot host it must fail creation — there is no fallback.
 */
export function createAnalysis(opts: CreateAnalysisInput): Result<Analysis, WorkspaceError> {
    if (!isDirWritable(opts.cwd)) {
        return err({
            type: "workspace_unavailable",
            message:
                `${opts.cwd} is not writable, so the analysis workspace cannot live there. ` +
                `Create the analysis in a writable folder (inputs can be referenced from anywhere).`,
        });
    }
    return getOrCreateAnchorForCwd(opts.cwd).andThen((anchor) =>
        uniqueSlugForAnchor(anchor.id, opts.name).andThen((slug): Result<Analysis, WorkspaceError> => {
            const now = Date.now();
            const analysis: Analysis = {
                id: randomUUIDv7(),
                projectId: opts.projectId ?? null,
                anchorId: anchor.id,
                name: opts.name,
                slug,
                createdAt: now,
                updatedAt: now,
            };
            // Inputs are user-driven: an analysis created without explicit paths starts with NONE.
            // We MUST NOT default to the anchor/cwd — that would silently enroll the entire working
            // directory (potentially tens of thousands of files) and let the open-time parity check
            // auto-trigger a data profile over all of it. Enrolling an input is always a deliberate
            // act (the file picker, `inflexa new <paths>`, or a later `addInputs`).
            const inputPaths = opts.inputPaths ?? [];
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
                    .andThen((created) => (inputPaths.length > 0 ? addInputs(created.id, inputPaths, opts.cwd).map(() => created) : ok(created)))
            );
        }),
    );
}

/** Outcome of {@link renameAnalysisAndMoveWorkspace}: the renamed analysis plus whether the on-disk tree moved with it. */
export type RenameOutcome = {
    analysis: Analysis;
    /** False when there was no tree to move (never created / user-deleted) OR the move itself failed — see `moveError`. */
    workspaceMoved: boolean;
    /** Set only when a tree existed at the old slug but could not be moved; the caller decides how loudly to surface it. */
    moveError?: unknown;
};

/**
 * Rename an analysis and move its workspace directory to the new slug. The slug keys the
 * on-disk workspace (`.inflexa/analyses/<slug>/`), so the rename and the move are one
 * deliberate action. Row first, then the move: the row is authoritative and the tree is
 * derived from it, so a crash (or a failed move) between the two leaves a missing tree at
 * the new slug — the normal desync condition the next use heals — plus a visible leftover
 * dir at the old slug, never a row pointing at bytes the rename lost. A missing source dir
 * is NOT an error (per the desync rule). Mid-run renames are excluded structurally: the
 * only rename surface lives in the TUI process that holds the analysis's instance lock.
 */
export function renameAnalysisAndMoveWorkspace(analysis: Analysis, name: Str256): Result<RenameOutcome, DbError> {
    return uniqueSlugForAnchor(analysis.anchorId, name).andThen((slug) =>
        renameAnalysis(analysis.id, name, slug).map((): RenameOutcome => {
            const renamed: Analysis = { ...analysis, name, slug };
            // Anchor resolution after the row update; writability is irrelevant here — a
            // read-only anchor still renames the row, and the move then fails visibly.
            const anchorPath = resolveAnchor(analysis.anchorId).match(
                (r) => r?.path ?? null,
                () => null,
            );
            if (anchorPath === null) return { analysis: renamed, workspaceMoved: false };
            const oldRoot = join(anchorPath, defaultOutputSubdir(analysis.slug));
            if (!existsSync(oldRoot)) return { analysis: renamed, workspaceMoved: false };
            return renameResult(oldRoot, join(anchorPath, defaultOutputSubdir(slug)), "renameAnalysisWorkspace").match(
                (): RenameOutcome => ({ analysis: renamed, workspaceMoved: true }),
                (e): RenameOutcome => ({ analysis: renamed, workspaceMoved: false, moveError: e.cause }),
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
