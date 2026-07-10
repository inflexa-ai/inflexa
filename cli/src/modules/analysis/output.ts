import { join } from "node:path";
import { err, ok, type Result } from "neverthrow";
import type { Analysis } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { findAnalysesByRef } from "../../db/primary_query.ts";
import { mkdirResult } from "../../lib/fs.ts";
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
 * Resolve an analysis's workspace root — the ONE place everything the analysis
 * touches lives: staged inputs (`data/`), run artifacts (`runs/`), reports,
 * previews, and provenance exports (see the path-resolution and write-boundary
 * specs). Exactly one rule: `join(anchorPath, ".inflexa", "analyses", slug)`,
 * derived live on every call — never persisted, so it follows anchor moves.
 * An unresolvable or non-writable anchor is an actionable error; there is no
 * fallback and no override. Does not create the directory.
 */
export function resolveOutputDir(analysis: Analysis): Result<string, WorkspaceError> {
    return resolveAnchor(analysis.anchorId).andThen((resolved) => {
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
 * {@link resolveOutputDir} from a bare analysis id — the lookup the harness's
 * `resolveWorkspaceRoot` seam realization and the TUI's card resolver need,
 * where only the id is in hand. A deleted row is a `workspace_unavailable`
 * (the workspace cannot exist for an analysis that doesn't), not a `DbError`.
 */
export function workspaceRootForAnalysisId(analysisId: string): Result<string, WorkspaceError> {
    return findAnalysesByRef(analysisId).andThen((rows) => {
        const analysis = rows[0] ?? null;
        if (analysis === null) {
            return err<string, WorkspaceError>({ type: "workspace_unavailable", message: `analysis ${analysisId} no longer exists` });
        }
        return resolveOutputDir(analysis);
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
