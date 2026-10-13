import { dirname, join } from "node:path";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef } from "../../db/primary_query.ts";
import { mkdirResultAsync, pathExistsAsync, renameResultAsync, rmResultAsync, type FsError } from "../../lib/fs.ts";
import { isDirWritable } from "../anchor/marker.ts";
import { resolveAnchor } from "../anchor/anchor.ts";

/**
 * Why an analysis's workspace cannot be used. `workspace_unavailable` is the
 * actionable, user-facing case (unresolvable anchor / non-writable folder) —
 * deliberately NOT a `DbError`: it is a property of the user's filesystem, not
 * a storage failure, and there is no fallback location to hide it behind. The
 * `message` names the folder and the remedy so every surface can print it as-is.
 */
export type WorkspaceError = DbError | { type: "workspace_unavailable"; message: string; cause?: unknown };

/**
 * An analysis's workspace sub-path under its anchor: `.inflexa/analyses/<slug>`. The single
 * source of this layout — shared by {@link resolveOutputDir} and provenance source-analysis
 * detection (which matches a stored input ref against it without resolving the anchor).
 */
export function defaultOutputSubdir(slug: string): string {
    return join(".inflexa", "analyses", slug);
}

/**
 * Where a deleted analysis's workspace is retired to: `.inflexa/analyses_archived/<slug>`.
 * A sibling of the live tree, not a child of it, so a freed slug can never resolve onto the
 * previous occupant's artifacts — and so `inflexa open` on a recreated analysis reveals an
 * empty folder rather than a stranger's runs.
 */
export function archivedOutputSubdir(slug: string): string {
    return join(".inflexa", "analyses_archived", slug);
}

/**
 * Resolve an analysis's workspace root — the ONE place everything the analysis
 * touches lives: staged inputs (`data/`), run artifacts (`runs/`), reports,
 * previews, and provenance exports (see the path-resolution and write-boundary
 * specs). Exactly one rule: `join(anchorPath, ".inflexa", "analyses", slug)`,
 * derived live on every call — never persisted, so it follows anchor moves.
 * An unresolvable or non-writable anchor is an actionable error; there is no
 * fallback and no override. Does not create the directory.
 */
/**
 * Locate an analysis's home anchor folder, or the shared actionable "cannot be
 * located" error. Split out so the write path ({@link resolveOutputDir}) and the
 * read-only reveal path ({@link locateExistingOutputDir}) report the same message
 * for a lost folder and differ only on the writability requirement.
 */
function locateAnchorPath(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    // `touch: false` — resolving a workspace root is not a folder sighting. This runs on the
    // harness's per-read path, where a heartbeat write would be both meaningless and hot.
    return resolveAnchor(analysis.anchorId, { touch: false }).andThen((resolved) => {
        const path = resolved?.path ?? null;
        if (path === null) {
            return errAsync<string, WorkspaceError>({
                type: "workspace_unavailable",
                message:
                    `analysis "${analysis.slug}": its home folder cannot be located (the folder was deleted or its .inflexa/id marker is gone). ` +
                    `Restore the folder or create the analysis again in a reachable location.`,
            });
        }
        return okAsync<string, WorkspaceError>(path);
    });
}

/**
 * The folder an analysis lives in — its anchor — from a bare id, or `null` when it cannot be located.
 *
 * `null` covers every reason the folder is not reachable: the analysis row is gone, its anchor row is
 * gone, or the marker's directory was deleted. All of them are routine desync between the database and
 * the user's filesystem rather than faults (see the no-hard-fail rule), and the sole caller — choosing
 * a working directory for a spawned child — has a sound fallback in every case, so a storage error
 * collapses into the same `null` instead of failing a command that would otherwise have run.
 */
export function anchorPathForAnalysisId(analysisId: string): Promise<string | null> {
    return findAnalysesByRef(analysisId)
        .asyncAndThen((rows) => {
            const analysis = rows[0];
            if (analysis === undefined) return okAsync<string | null, DbError>(null);
            // `touch: false` — picking a working directory is not a folder sighting.
            return resolveAnchor(analysis.anchorId, { touch: false }).map((resolved) => resolved?.path ?? null);
        })
        .match(
            (path) => path,
            () => null,
        );
}

export function resolveOutputDir(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    return locateAnchorPath(analysis).andThen((path) => new ResultAsync(writableOutputDir(analysis, path)));
}

async function writableOutputDir(analysis: Analysis, path: string): Promise<Result<string, WorkspaceError>> {
    if (!(await isDirWritable(path))) {
        return err({
            type: "workspace_unavailable",
            message:
                `analysis "${analysis.slug}": its folder ${path} is not writable, so the workspace at ` +
                `${join(path, defaultOutputSubdir(analysis.slug))} cannot be written. ` +
                `Make the folder writable, or create the analysis in a writable folder (inputs can be referenced from anywhere).`,
        });
    }
    return ok(join(path, defaultOutputSubdir(analysis.slug)));
}

/**
 * Locate an analysis's workspace root for a READ-ONLY reveal (`inflexa open`),
 * returning the directory only when it already exists on disk. Unlike
 * {@link resolveOutputDir} this does NOT require the home folder to be writable:
 * a tree that was already materialized stays revealable even if its folder later
 * went read-only (a mounted volume, a `chmod`). `ok(null)` means the folder is
 * reachable but nothing was ever written there — the caller decides whether to
 * create it. `workspace_unavailable` is reserved for a folder that cannot be found.
 */
export function locateExistingOutputDir(analysis: Analysis): ResultAsync<string | null, WorkspaceError> {
    return locateOutputDir(analysis).map(async (dir) => ((await pathExistsAsync(dir)) ? dir : null));
}

/**
 * The output folder for an open: an existing folder as it is, else the folder made. An existing folder is given
 * even when its home folder went read-only, because results that the person already has must stay reachable.
 * Only an absent folder is made, which needs a writable home folder.
 */
export function locateOrEnsureOutputDir(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    return locateExistingOutputDir(analysis).andThen((existing) => (existing !== null ? okAsync(existing) : ensureOutputDir(analysis)));
}

/**
 * The workspace root of an analysis for a READ, whether or not the tree exists yet. Unlike {@link resolveOutputDir}
 * it does not require a writable home folder, thus a tree whose folder went read-only stays readable.
 */
function locateOutputDir(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    return locateAnchorPath(analysis).map((path) => join(path, defaultOutputSubdir(analysis.slug)));
}

/**
 * {@link locateOutputDir} from a bare analysis id. It reads no memo and writes nothing, because a read of a file
 * must not require a write permission. A deleted row is a `workspace_unavailable`, as in {@link workspaceRootForAnalysisId}.
 */
export function readableWorkspaceRootForAnalysisId(analysisId: string): ResultAsync<string, WorkspaceError> {
    return findAnalysesByRef(analysisId).asyncAndThen((rows) => {
        const analysis = rows[0] ?? null;
        if (analysis === null) {
            return errAsync<string, WorkspaceError>({ type: "workspace_unavailable", message: `analysis ${analysisId} no longer exists` });
        }
        return locateOutputDir(analysis);
    });
}

/**
 * The `data/` root of an analysis's workspace — the `targetDir` contract of
 * `stageInputs`, which writes `inputs/local/{key}` beneath it. Passing anything
 * deeper (e.g. an `…/inputs` path) doubles the segment.
 */
export function workspaceDataDir(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    return resolveOutputDir(analysis).map((root) => join(root, "data"));
}

/**
 * How long a resolved root may be reused before it is derived again. Bounds the staleness of an
 * anchor move made by another process (`inflexa relocate`, a folder moved between commands) —
 * moves made by THIS process invalidate the entry outright, so the window only covers the case
 * the derivation cannot observe.
 */
const ROOT_CACHE_TTL_MS = 5_000;

/** Successful resolutions only: an error must re-derive at once, since the user may be fixing it. */
const rootCache = new Map<string, { root: string; resolvedAt: number }>();

/**
 * The derivation in flight for each analysis. Each caller that arrives during it shares it, thus a burst of
 * agent reads costs one derivation. The entry goes when the derivation ends, so an error reaches only the
 * callers that waited on it, and the next caller derives again.
 */
const rootInFlight = new Map<string, Promise<Result<string, WorkspaceError>>>();

/**
 * Forget a cached root — after a rename moves the tree, or a delete retires it. Pass no id to
 * clear the whole cache (tests, which reset the database beneath it). A derivation in flight is
 * dropped too: its root can name the tree from before the move, thus it must not reach the cache.
 */
export function invalidateWorkspaceRoot(analysisId?: string): void {
    if (analysisId === undefined) {
        rootCache.clear();
        rootInFlight.clear();
    } else {
        rootCache.delete(analysisId);
        rootInFlight.delete(analysisId);
    }
}

/**
 * {@link resolveOutputDir} from a bare analysis id — the lookup the harness's
 * `resolveWorkspaceRoot` seam realization and the TUI's card resolver need,
 * where only the id is in hand. A deleted row is a `workspace_unavailable`
 * (the workspace cannot exist for an analysis that doesn't), not a `DbError`.
 *
 * Memoized: the harness calls this once per `read_file` / `grep` / `stat` the agent issues, and
 * each derivation costs a row lookup, an anchor lookup, a marker read, and an `access(2)`. The
 * cache is process memory and starts empty, so a workflow recovered on a fresh process still
 * resolves from durable state — the property the workspace-root-resolution spec requires of the
 * seam, and the reason the memo may not be seeded from anywhere but this function.
 */
export function workspaceRootForAnalysisId(analysisId: string): ResultAsync<string, WorkspaceError> {
    const cached = rootCache.get(analysisId);
    if (cached !== undefined && Date.now() - cached.resolvedAt < ROOT_CACHE_TTL_MS) return okAsync(cached.root);

    const inFlight = rootInFlight.get(analysisId);
    if (inFlight !== undefined) return new ResultAsync(inFlight);

    const started: Promise<Result<string, WorkspaceError>> = deriveWorkspaceRoot(analysisId).then((result) => {
        // An invalidation during the derivation removed this entry, and its root then must not be cached.
        if (rootInFlight.get(analysisId) === started) {
            rootInFlight.delete(analysisId);
            if (result.isOk()) rootCache.set(analysisId, { root: result.value, resolvedAt: Date.now() });
        }
        return result;
    });
    rootInFlight.set(analysisId, started);
    return new ResultAsync(started);
}

async function deriveWorkspaceRoot(analysisId: string): Promise<Result<string, WorkspaceError>> {
    return await findAnalysesByRef(analysisId).asyncAndThen((rows) => {
        const analysis = rows[0] ?? null;
        if (analysis === null) {
            return errAsync<string, WorkspaceError>({ type: "workspace_unavailable", message: `analysis ${analysisId} no longer exists` });
        }
        return resolveOutputDir(analysis);
    });
}

/** What happened to an analysis's on-disk workspace when the analysis was deleted. */
export type WorkspaceDisposal =
    | { kind: "archived"; path: string }
    | { kind: "deleted"; path: string }
    /** There was no tree to dispose of — never created, already removed, or its folder is gone. */
    | { kind: "absent" };

/** First unused `.inflexa/analyses_archived/<slug>` name, so archiving the same slug twice never clobbers. */
async function freeArchivePath(anchorPath: string, slug: string): Promise<string> {
    const base = join(anchorPath, archivedOutputSubdir(slug));
    if (!(await pathExistsAsync(base))) return base;
    for (let i = 2; ; i++) {
        const candidate = `${base}-${i}`;
        if (!(await pathExistsAsync(candidate))) return candidate;
    }
}

/**
 * Retire a deleted analysis's workspace tree.
 *
 * Deleting the row alone is not enough: the slug keys the directory, and `uniqueSlugForAnchor`
 * hands a freed slug straight to the next analysis of the same name — which would then resolve
 * onto its predecessor's `runs/`, `previews/`, and provenance exports. The tree must leave
 * `analyses/` either way; `archive` keeps the bytes (the default — a run's artifacts are the
 * user's, not ours to destroy), `delete` does not.
 */
export function disposeWorkspace(
    analysis: Analysis,
    mode: "archive" | "delete",
    removeTree: (path: string) => ResultAsync<void, FsError> = (path) => rmResultAsync(path, "disposeWorkspace:delete"),
): ResultAsync<WorkspaceDisposal, WorkspaceError> {
    return resolveAnchor(analysis.anchorId, { touch: false }).andThen((resolved): ResultAsync<WorkspaceDisposal, WorkspaceError> => {
        const anchorPath = resolved?.path ?? null;
        // Drop any cached root up front so the disposal is never shadowed by a stale
        // memo, regardless of which branch we return through below.
        invalidateWorkspaceRoot(analysis.id);
        // The tree lived inside the anchor folder, so an unlocatable folder took it along.
        if (anchorPath === null) return okAsync({ kind: "absent" });

        const root = join(anchorPath, defaultOutputSubdir(analysis.slug));
        return ResultAsync.fromSafePromise(pathExistsAsync(root)).andThen((exists): ResultAsync<WorkspaceDisposal, WorkspaceError> => {
            if (!exists) return okAsync({ kind: "absent" });

            if (mode === "delete") {
                return removeTree(root)
                    .map((): WorkspaceDisposal => ({ kind: "deleted", path: root }))
                    .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "disposeWorkspace", cause: e.cause }));
            }

            return ResultAsync.fromSafePromise(freeArchivePath(anchorPath, analysis.slug)).andThen((dest) =>
                mkdirResultAsync(dirname(dest), "disposeWorkspace:mkdir")
                    .andThen(() => renameResultAsync(root, dest, "disposeWorkspace:archive"))
                    .map((): WorkspaceDisposal => ({ kind: "archived", path: dest }))
                    .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "disposeWorkspace", cause: e.cause })),
            );
        });
    });
}

/**
 * `resolveOutputDir` + `mkdir -p` (idempotent). The workspace root is the only writable target
 * (the write boundary); nothing here touches source data. Resolution errors propagate unchanged.
 */
export function ensureOutputDir(analysis: Analysis): ResultAsync<string, WorkspaceError> {
    return resolveOutputDir(analysis).andThen((dir) =>
        mkdirResultAsync(dir, "ensureOutputDir")
            .map(() => dir)
            .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "ensureOutputDir", cause: e.cause })),
    );
}
