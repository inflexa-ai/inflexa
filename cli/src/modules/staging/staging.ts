import { linkSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ok, err, Result } from "neverthrow";
import type { AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { resolveInputPath } from "../analysis/input.ts";
import { sha256File } from "../../lib/hash.ts";
import { mkdirResult, statResult } from "../../lib/fs.ts";
import type { FsError } from "../../lib/fs.ts";

/**
 * One input file staged under the analysis data dir, with its content hash.
 * Shape matches the harness's `StagedInput` (`@inflexa-ai/harness`,
 * src/execution/staged-input.ts) field-for-field, so the manifest is
 * wire-compatible without a transform layer.
 */
export type StagedInput = {
    /** Deterministic identity derived from the input's anchor+path — opaque to the harness. */
    readonly fileId: string;
    /** Source grouping label. `"local"` for all CLI-staged files (single flat mount). */
    readonly mountName: string;
    /** Relative path within the mount (the stored input path or subtree-relative path). */
    readonly key: string;
    /** The file's basename. */
    readonly fileName: string;
    /** SHA-256 hex digest of the file content. */
    readonly hash: string;
    /** File size in bytes. */
    readonly size: number;
    /** Path relative to the data dir: `inputs/{mountName}/{key}`. */
    readonly relativePath: string;
};

/**
 * Deterministic file identity from the input's anchor+path. Uses Bun.hash for
 * speed (non-crypto). For single-file inputs the hashed key (`anchorId|path`)
 * is the same key space as `inputQName` in `modules/prov/document.ts`, so
 * provenance and staging agree on identity without importing each other.
 * Directory members extend the key with the member's subpath
 * (`anchorId|path/subpath`) — provenance models the directory input as ONE
 * entity, so per-member ids intentionally live outside its key space.
 */
function deriveFileId(input: AnalysisInput, subpath?: string): string {
    const key = `${input.anchorId ?? ""}|${subpath ? `${input.path}/${subpath}` : input.path}`;
    return Bun.hash(key).toString(36);
}

/**
 * Link a file into the staging tree, replacing any stale destination. Hardlinks are
 * preferred (fast, zero-copy, safe because the harness mounts the session tree
 * read-only into sandboxes); the copy fallback covers cross-filesystem boundaries.
 */
function stageFile(src: string, dest: string): Result<void, FsError> {
    return mkdirResult(dirname(dest), "stageFile:mkdir").andThen(() => {
        // Remove any stale destination before linking: re-staging must refresh, and a
        // stale dest is typically a hardlink OF src itself — linkSync would fail EEXIST
        // and copyFileSync onto the same inode truncates the source before reading it
        // (libuv performs no same-file check), destroying the user's input.
        try {
            rmSync(dest, { force: true });
        } catch (cause) {
            return err({ type: "io_failed", op: "stageFile:rm", cause } as FsError);
        }
        try {
            linkSync(src, dest);
        } catch {
            try {
                copyFileSync(src, dest);
            } catch (cause) {
                return err({ type: "io_failed", op: "stageFile:copy", cause } as FsError);
            }
        }
        return ok(undefined);
    });
}

/**
 * Recursively enumerate all files under `dir`, returning paths relative to `dir`.
 * Directories are traversed, not yielded. Dirent kind checks answer false for
 * symlinks on both `isFile()` and `isDirectory()`, so symlink entries are
 * stat-resolved explicitly: a link to a file is yielded, a link to a directory is
 * traversed, and a dangling link is skipped — an unreadable target is a property
 * of the user's source tree, not a staging failure.
 */
function walkFiles(dir: string): Result<string[], FsError> {
    try {
        const results: string[] = [];
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const full = join(dir, entry.name);
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                const target = statResult(full, "walkFiles:stat");
                if (target.isErr()) continue;
                isDirectory = target.value.isDirectory();
                isFile = target.value.isFile();
            }
            if (isDirectory) {
                const subResult = walkFiles(full);
                if (subResult.isErr()) return subResult;
                for (const sub of subResult.value) {
                    results.push(join(entry.name, sub));
                }
            } else if (isFile) {
                results.push(entry.name);
            }
        }
        return ok(results);
    } catch (cause) {
        return err({ type: "io_failed", op: "walkFiles", cause });
    }
}

/**
 * Stage a single file input: hash, link/copy into the target tree, return a `StagedInput`.
 */
async function stageSingleFile(absPath: string, key: string, fileId: string, targetDir: string): Promise<Result<StagedInput, FsError>> {
    const relPath = join("inputs", "local", key);
    const dest = join(targetDir, relPath);
    const stageResult = stageFile(absPath, dest);
    if (stageResult.isErr()) return err(stageResult.error);

    const hashResult = await sha256File(absPath);
    if (hashResult.isErr()) return err(hashResult.error);

    const sizeResult = statResult(absPath, "stageSingleFile:stat");
    if (sizeResult.isErr()) return err(sizeResult.error);

    return ok({
        fileId,
        mountName: "local",
        key,
        fileName: basename(absPath),
        hash: hashResult.value,
        size: sizeResult.value.size,
        relativePath: relPath,
    });
}

/** Staging-layer error: wraps I/O failures from the filesystem operations during staging. */
export type StagingError = { type: "staging_failed"; cause: unknown };

/**
 * Resolve an analysis's inputs to absolute paths, copy/link them into a staging tree,
 * compute content hashes, and return the `StagedInput[]` manifest the harness consumes.
 *
 * @param analysisId - The analysis whose inputs to stage.
 * @param targetDir - The data directory root (`sessionTreeDataDir(analysisId)` — see
 *   paths.ts). Staged files are written under `{targetDir}/inputs/local/{key}`; do NOT
 *   pass a path already ending in `inputs` or the tree doubles the segment.
 * @returns The staged manifest, or a `DbError`/`StagingError` if resolution or I/O fails.
 *   Inputs that can't be resolved to an absolute path (e.g. orphaned anchor) are skipped
 *   with a warning — partial staging is better than total failure for best-effort scenarios.
 */
export async function stageInputs(analysisId: string, targetDir: string): Promise<Result<StagedInput[], DbError | StagingError>> {
    const inputsResult = listAnalysisInputs(analysisId);
    if (inputsResult.isErr()) return err(inputsResult.error);

    const resolveResult = Result.combine(inputsResult.value.map((input) => resolveInputPath(input).map((absPath) => ({ input, absPath }))));
    if (resolveResult.isErr()) return err(resolveResult.error);

    const resolvedInputs = resolveResult.value.filter((p): p is { input: AnalysisInput; absPath: string } => p.absPath !== null);

    const staged: StagedInput[] = [];
    for (const { input, absPath } of resolvedInputs) {
        if (input.isDir) {
            const filesResult = walkFiles(absPath);
            if (filesResult.isErr()) return err({ type: "staging_failed", cause: filesResult.error });
            for (const subpath of filesResult.value) {
                const fullPath = join(absPath, subpath);
                const key = join(input.path, subpath);
                const fileId = deriveFileId(input, subpath);
                const result = await stageSingleFile(fullPath, key, fileId, targetDir);
                if (result.isErr()) return err({ type: "staging_failed", cause: result.error });
                staged.push(result.value);
            }
        } else {
            const key = input.path;
            const fileId = deriveFileId(input);
            const result = await stageSingleFile(absPath, key, fileId, targetDir);
            if (result.isErr()) return err({ type: "staging_failed", cause: result.error });
            staged.push(result.value);
        }
    }
    return ok(staged);
}
