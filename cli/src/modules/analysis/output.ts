import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef } from "../../db/primary_query.ts";
import { mkdirResult, renameResult, rmResult } from "../../lib/fs.ts";
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
export function resolveOutputDir(analysis: Analysis): Result<string, WorkspaceError> {
    // `touch: false` — resolving a workspace root is not a folder sighting. This runs on the
    // harness's per-read path, where a heartbeat write would be both meaningless and hot.
    return resolveAnchor(analysis.anchorId, { touch: false }).andThen((resolved) => {
        const path = resolved?.path ?? null;
        if (path === null) {
            return err<string, WorkspaceError>({
                type: "workspace_unavailable",
                message:
                    `analysis "${analysis.slug}": its home folder cannot be located (the folder was deleted or its .inflexa/id marker is gone). ` +
                    `Restore the folder or create the analysis again in a reachable location.`,
            });
        }
        if (!isDirWritable(path)) {
            return err<string, WorkspaceError>({
                type: "workspace_unavailable",
                message:
                    `analysis "${analysis.slug}": its folder ${path} is not writable, so the workspace at ` +
                    `${join(path, defaultOutputSubdir(analysis.slug))} cannot be written. ` +
                    `Make the folder writable, or create the analysis in a writable folder (inputs can be referenced from anywhere).`,
            });
        }
        return ok(join(path, defaultOutputSubdir(analysis.slug)));
    });
}

/**
 * The `data/` root of an analysis's workspace — the `targetDir` contract of
 * `stageInputs`, which writes `inputs/local/{key}` beneath it. Passing anything
 * deeper (e.g. an `…/inputs` path) doubles the segment.
 */
export function workspaceDataDir(analysis: Analysis): Result<string, WorkspaceError> {
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
 * Forget a cached root — after a rename moves the tree, or a delete retires it. Pass no id to
 * clear the whole cache (tests, which reset the database beneath it).
 */
export function invalidateWorkspaceRoot(analysisId?: string): void {
    if (analysisId === undefined) rootCache.clear();
    else rootCache.delete(analysisId);
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
export function workspaceRootForAnalysisId(analysisId: string): Result<string, WorkspaceError> {
    const cached = rootCache.get(analysisId);
    if (cached !== undefined && Date.now() - cached.resolvedAt < ROOT_CACHE_TTL_MS) return ok(cached.root);

    return findAnalysesByRef(analysisId).andThen((rows) => {
        const analysis = rows[0] ?? null;
        if (analysis === null) {
            return err<string, WorkspaceError>({ type: "workspace_unavailable", message: `analysis ${analysisId} no longer exists` });
        }
        return resolveOutputDir(analysis).map((root) => {
            rootCache.set(analysisId, { root, resolvedAt: Date.now() });
            return root;
        });
    });
}

/** What happened to an analysis's on-disk workspace when the analysis was deleted. */
export type WorkspaceDisposal =
    | { kind: "archived"; path: string }
    | { kind: "deleted"; path: string }
    /** There was no tree to dispose of — never created, already removed, or its folder is gone. */
    | { kind: "absent" };

/** First unused `.inflexa/analyses_archived/<slug>` name, so archiving the same slug twice never clobbers. */
function freeArchivePath(anchorPath: string, slug: string): string {
    const base = join(anchorPath, archivedOutputSubdir(slug));
    if (!existsSync(base)) return base;
    for (let i = 2; ; i++) {
        const candidate = `${base}-${i}`;
        if (!existsSync(candidate)) return candidate;
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
export function disposeWorkspace(analysis: Analysis, mode: "archive" | "delete"): Result<WorkspaceDisposal, WorkspaceError> {
    return resolveAnchor(analysis.anchorId, { touch: false }).andThen((resolved): Result<WorkspaceDisposal, WorkspaceError> => {
        const anchorPath = resolved?.path ?? null;
        // The tree lived inside the anchor folder, so an unlocatable folder took it along.
        if (anchorPath === null) return ok({ kind: "absent" });

        const root = join(anchorPath, defaultOutputSubdir(analysis.slug));
        if (!existsSync(root)) return ok({ kind: "absent" });

        invalidateWorkspaceRoot(analysis.id);

        if (mode === "delete") {
            return rmResult(root, "disposeWorkspace:delete")
                .map((): WorkspaceDisposal => ({ kind: "deleted", path: root }))
                .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "disposeWorkspace", cause: e.cause }));
        }

        const dest = freeArchivePath(anchorPath, analysis.slug);
        return mkdirResult(dirname(dest), "disposeWorkspace:mkdir")
            .andThen(() => renameResult(root, dest, "disposeWorkspace:archive"))
            .map((): WorkspaceDisposal => ({ kind: "archived", path: dest }))
            .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "disposeWorkspace", cause: e.cause }));
    });
}

/**
 * `resolveOutputDir` + `mkdir -p` (idempotent). The workspace root is the only writable target
 * (the write boundary); nothing here touches source data. Resolution errors propagate unchanged.
 */
export function ensureOutputDir(analysis: Analysis): Result<string, WorkspaceError> {
    return resolveOutputDir(analysis).andThen((dir) =>
        mkdirResult(dir, "ensureOutputDir")
            .map(() => dir)
            .mapErr((e): WorkspaceError => ({ type: "mutation_failed", op: "ensureOutputDir", cause: e.cause })),
    );
}
