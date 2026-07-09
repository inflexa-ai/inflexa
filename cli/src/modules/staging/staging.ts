import { linkSync, copyFileSync, readdirSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ok, err, Result } from "neverthrow";
import type { AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { resolveInputPath } from "../analysis/input.ts";
import { sha256File } from "../../lib/hash.ts";
import { mkdirResult, statResult } from "../../lib/fs.ts";
import type { FsError } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";

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
    /** Source file's last-modification time, epoch ms. With `size` + `fileId`, the drift signature. */
    readonly mtimeMs: number;
    /** Path relative to the data dir: `inputs/{mountName}/{key}`. */
    readonly relativePath: string;
};

/**
 * The value a drift check compares: identity PLUS the two cheap facts that change when a
 * file's bytes do. `fileId` alone is a path identity — `deriveFileId` hashes `anchorId|path`
 * and nothing else — so two profiles taken over the same paths with different content compare
 * equal, and an in-place edit is invisible.
 *
 * Deliberately NOT the content hash: `enumerateInputSignatures` runs on every chat open and
 * every input mutation, and reading every input in full (these are genomics files) is the cost
 * it exists to avoid. `stageInputs` pays the SHA-256; parity does not.
 *
 * `mtimeMs` is used at FULL precision, fraction included. Both comparands come from `statSync` on the
 * same source file, and the recorded one round-trips JS → JSON → Postgres `jsonb` → JS exactly, so the
 * fraction is stable on both sides. Rounding it away would be a real loss: a same-size rewrite lands
 * inside one millisecond often enough to matter (measured: 193 of 200 back-to-back rewrites shared a
 * whole-millisecond mtime), and the sub-millisecond digits are the only thing distinguishing them.
 *
 * Accepted miss: an edit preserving byte length AND mtime — a filesystem with coarse (1s) timestamp
 * granularity, or a rewrite that restores the original mtime.
 */
export function inputSignature(fileId: string, size: number, mtimeMs: number): string {
    return `${fileId}:${size}:${mtimeMs}`;
}

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
    // The callback's return type is annotated so the `err(...)` object literals below infer
    // `type: "io_failed"` as the literal, not `string` — without it each would need an `as FsError`.
    return mkdirResult(dirname(dest), "stageFile:mkdir").andThen((): Result<void, FsError> => {
        // Remove any stale destination before linking: re-staging must refresh, and a
        // stale dest is typically a hardlink OF src itself — linkSync would fail EEXIST
        // and copyFileSync onto the same inode truncates the source before reading it
        // (libuv performs no same-file check), destroying the user's input.
        try {
            rmSync(dest, { force: true });
        } catch (cause) {
            return err({ type: "io_failed", op: "stageFile:rm", cause });
        }
        try {
            linkSync(src, dest);
        } catch {
            try {
                copyFileSync(src, dest);
            } catch (cause) {
                return err({ type: "io_failed", op: "stageFile:copy", cause });
            }
        }
        return ok(undefined);
    });
}

/**
 * Directory names a directory-input walk never descends into. The first group
 * mirrors the harness's sandbox-side `IGNORED_DIRS` (`sandbox/ignored-dirs.ts`)
 * so what staging materializes matches what the harness's own walks treat as
 * data. The second group is cli-specific: source control and the anchor-marker
 * dir show up whenever a user selects a project root as a directory input, and
 * are never analysis data. Kept as a cli-owned constant (not imported from the
 * harness) because the two lists answer different questions — runtime tool
 * noise vs. what counts as user data — and only happen to overlap today.
 */
const IGNORED_WALK_DIRS: ReadonlySet<string> = new Set([
    ".ruff_cache",
    "__pycache__",
    ".cache",
    ".ipynb_checkpoints",
    "node_modules",
    ".Rproj.user",
    ".git",
    ".inflexa",
]);

const WALK_EVERYTHING: ReadonlySet<string> = new Set();

/**
 * Recursively enumerate all files under `dir`, returning paths relative to `dir`.
 * Directories are traversed, not yielded; directories named in `ignoredDirs` are
 * skipped whole (staging passes {@link IGNORED_WALK_DIRS}; the reconcile pass
 * passes an empty set — it must see files staged under names that are ignored
 * NOW but were not when they were staged). Dirent kind checks answer false for
 * symlinks on both `isFile()` and `isDirectory()`, so symlink entries are
 * stat-resolved explicitly: a link to a file is yielded, a link to a directory is
 * traversed, and a dangling link is skipped — an unreadable target is a property
 * of the user's source tree, not a staging failure.
 */
function walkFiles(dir: string, ignoredDirs: ReadonlySet<string>): Result<string[], FsError> {
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
                if (ignoredDirs.has(entry.name)) continue;
                const subResult = walkFiles(full, ignoredDirs);
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
 * The write half of staging: take one walked {@link InputFile}, hash its content,
 * link/copy it into the target tree, and return its `StagedInput` manifest row.
 * {@link walkInputFiles} has already decided WHICH files exist and their identity
 * (`fileId`/`key`/`relativePath`); this only pays the content-size costs. Split out
 * so {@link enumerateInputSignatures} can share the walk without any of them.
 */
async function materializeStagedFile(file: InputFile, targetDir: string): Promise<Result<StagedInput, FsError>> {
    const dest = join(targetDir, file.relativePath);
    const stageResult = stageFile(file.absPath, dest);
    if (stageResult.isErr()) return err(stageResult.error);

    const hashResult = await sha256File(file.absPath);
    if (hashResult.isErr()) return err(hashResult.error);

    // One stat yields both drift-signature components, so the manifest's signature is
    // consistent with the one `enumerateInputSignatures` computes for the same file.
    const statsResult = statResult(file.absPath, "materializeStagedFile:stat");
    if (statsResult.isErr()) return err(statsResult.error);

    return ok({
        fileId: file.fileId,
        mountName: "local",
        key: file.key,
        fileName: basename(file.absPath),
        hash: hashResult.value,
        size: statsResult.value.size,
        // Verbatim, fraction and all: this is the value the ledger records, and `enumerateInputSignatures`
        // compares it against a fresh `statSync` of the same file. Rounding here and not there — or the
        // reverse — would make every analysis read as permanently drifted.
        mtimeMs: statsResult.value.mtimeMs,
        relativePath: file.relativePath,
    });
}

/** Staging-layer error: wraps I/O failures from the filesystem operations during staging. */
export type StagingError = { type: "staging_failed"; cause: unknown };

/** Remove now-empty directories under `dir` (bottom-up), leaving `dir` itself in place. */
function pruneEmptyDirs(dir: string): Result<void, FsError> {
    try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const full = join(dir, entry.name);
            const sub = pruneEmptyDirs(full);
            if (sub.isErr()) return sub;
            if (readdirSync(full).length === 0) rmdirSync(full);
        }
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", op: "pruneEmptyDirs", cause });
    }
}

/**
 * The un-staging half of the contract: delete staged files no current input
 * produced, then prune the directories emptied by those deletions. Runs at
 * staging time — the one moment the full expected manifest is in hand —
 * because inputs can disappear underneath the tree in ways removal-time
 * cleanup can never key on (the input row is deleted, an anchor stops
 * resolving, an ignore rule newly excludes a subtree). The walk here passes no
 * ignore set: it must see files staged under names the staging walk now
 * skips, or they would linger forever.
 */
function reconcileStagedTree(targetDir: string, staged: StagedInput[]): Result<void, FsError> {
    const localRoot = join(targetDir, "inputs", "local");
    if (!existsSync(localRoot)) return ok(undefined);

    const existingResult = walkFiles(localRoot, WALK_EVERYTHING);
    if (existingResult.isErr()) return err(existingResult.error);

    // Compare absolute path to absolute path — `join` normalizes both sides.
    // Comparing the walk's relative paths against manifest KEYS is wrong the
    // moment a key isn't a clean relative path (join collapses a leading slash
    // when writing, so key and on-disk path diverge and reconcile would delete
    // freshly staged files).
    const expected = new Set(staged.map((s) => join(targetDir, s.relativePath)));
    for (const rel of existingResult.value) {
        const abs = join(localRoot, rel);
        if (expected.has(abs)) continue;
        try {
            rmSync(abs, { force: true });
        } catch (cause) {
            return err({ type: "io_failed", op: "reconcileStagedTree:rm", cause });
        }
    }
    return pruneEmptyDirs(localRoot);
}

/**
 * One file an input yields, its staging identity resolved but no content touched.
 * The unit both {@link stageInputs} and {@link enumerateInputSignatures} consume:
 * `absPath` is the source to read, `relativePath` its dest under `inputs/local`,
 * and `key`/`fileId` its manifest identity. Only {@link walkInputFiles} mints
 * these, so the two callers cannot disagree about which files an input yields.
 */
type InputFile = {
    /** The owning input row — carries the anchor and the stored path. */
    readonly input: AnalysisInput;
    /** Absolute source path of this file on the host. */
    readonly absPath: string;
    /** Relative key within the `local` mount (directory members carry their subpath). */
    readonly key: string;
    /** Deterministic identity from {@link deriveFileId} — the space provenance also uses. */
    readonly fileId: string;
    /** Dest path relative to the data dir: `inputs/local/{key}`. */
    readonly relativePath: string;
};

/**
 * The shared read-only walk under both staging and id enumeration: list the
 * analysis's inputs, resolve each to an absolute path (skipping any that can't
 * resolve — e.g. an orphaned anchor), then expand every input into the files it
 * yields — a directory input walks its subtree via {@link walkFiles} under the
 * noise-dir skips and symlink rules; a file input yields itself. Cost is bounded
 * by stat/readdir: no hashing, no tree writes. This is the SINGLE source of
 * "which files an input yields"; {@link stageInputs} adds materialization on top
 * and {@link enumerateInputSignatures} adds nothing, so their identity spaces are
 * structurally unable to diverge.
 */
function walkInputFiles(analysisId: string): Result<InputFile[], DbError | StagingError> {
    const inputsResult = listAnalysisInputs(analysisId);
    if (inputsResult.isErr()) return err(inputsResult.error);

    const resolveResult = Result.combine(inputsResult.value.map((input) => resolveInputPath(input).map((absPath) => ({ input, absPath }))));
    if (resolveResult.isErr()) return err(resolveResult.error);

    const resolvedInputs = resolveResult.value.filter((p): p is { input: AnalysisInput; absPath: string } => p.absPath !== null);

    const files: InputFile[] = [];
    for (const { input, absPath } of resolvedInputs) {
        // Resolve existence ONCE, in the walk both callers share, so enumeration and staging can never
        // disagree about whether a source is still on disk. A source deleted while its input row
        // survives is a routine DB/filesystem desync — the user may delete an input at any moment — not
        // a fault: treat it as removed and skip it here. Without this shared gate the two callers
        // diverge: enumeration skips the stat-missing file and reports drift, but staging deletes the
        // previously staged copy and then fails to re-link the gone source, which wedges the
        // drift-repair loop into a recurring "could not start profiling" toast that never converges.
        // Directory MEMBERS are existence-checked by `walkFiles` itself; this covers the input root — a
        // lone file, or a whole directory that vanished (whose `walkFiles` would otherwise ENOENT-fault
        // in staging while enumeration silently skipped it).
        if (statResult(absPath, "walkInputFiles:exists").isErr()) {
            getLogger("staging").warn({ absPath, path: input.path }, "input source missing on disk — skipping it (treating it as removed)");
            continue;
        }
        // Anchored inputs keep their human-readable anchor-relative path as the
        // key. Anchorless inputs carry an ABSOLUTE host path — used verbatim it
        // leaks the host filesystem into the sandbox layout and the agent
        // prompt, and `join` silently collapses its leading slash so the
        // on-disk path no longer matches the key. They stage under a stable
        // fileId-prefixed basename instead (collision-free across same-named
        // files from different locations, deterministic across runs).
        const keyRoot = input.anchorId === null ? join(deriveFileId(input), basename(input.path)) : input.path;
        if (input.isDir) {
            const walkResult = walkFiles(absPath, IGNORED_WALK_DIRS);
            if (walkResult.isErr()) return err({ type: "staging_failed", cause: walkResult.error });
            for (const subpath of walkResult.value) {
                const key = join(keyRoot, subpath);
                files.push({ input, absPath: join(absPath, subpath), key, fileId: deriveFileId(input, subpath), relativePath: join("inputs", "local", key) });
            }
        } else {
            files.push({ input, absPath, key: keyRoot, fileId: deriveFileId(input), relativePath: join("inputs", "local", keyRoot) });
        }
    }
    return ok(files);
}

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
 *
 * The staged tree MIRRORS the current inputs: files under `inputs/local` that no
 * current input produced are deleted and emptied directories pruned, so removing
 * an input (or an ignore rule newly excluding a subtree) cleans up on the next run.
 */
export async function stageInputs(analysisId: string, targetDir: string): Promise<Result<StagedInput[], DbError | StagingError>> {
    const filesResult = walkInputFiles(analysisId);
    if (filesResult.isErr()) return err(filesResult.error);

    const staged: StagedInput[] = [];
    for (const file of filesResult.value) {
        const result = await materializeStagedFile(file, targetDir);
        if (result.isErr()) return err({ type: "staging_failed", cause: result.error });
        staged.push(result.value);
    }

    // Overlapping inputs stage to the SAME dest path: a directory input plus a
    // file input inside it, or two anchors whose subtrees share a relative path.
    // Sequential linking leaves the last writer's bytes on disk, and two manifest
    // entries with one `relativePath` would break the harness's multi-row artifact
    // upsert — Postgres rejects two rows that hit the same ON CONFLICT key in a
    // single statement. Dedup by `relativePath`, keeping the LAST entry so the
    // manifest matches what is actually on disk; warn only when the dropped entry
    // held DIFFERENT content (a genuine input clash, not the benign dir-holds-file
    // overlap where both resolve to the same source).
    const byPath = new Map<string, StagedInput>();
    for (const entry of staged) {
        const prior = byPath.get(entry.relativePath);
        if (prior && prior.hash !== entry.hash) {
            getLogger("staging").warn(
                { relativePath: entry.relativePath, droppedKey: prior.key, keptKey: entry.key },
                "two inputs stage to the same path with different content — keeping the last-staged file",
            );
        }
        byPath.set(entry.relativePath, entry);
    }
    const uniqueStaged = [...byPath.values()];

    const reconcileResult = reconcileStagedTree(targetDir, uniqueStaged);
    if (reconcileResult.isErr()) return err({ type: "staging_failed", cause: reconcileResult.error });

    return ok(uniqueStaged);
}

/**
 * The read-only, hash-free twin of {@link stageInputs}: the {@link inputSignature} set
 * staging would produce for `analysisId`, in the SAME identity space, but without
 * touching content (no `sha256File`), linking, copying, or writing the session
 * tree — which need not even exist. Both funnel through {@link walkInputFiles}, so
 * the id spaces cannot diverge; the dedup by `relativePath` mirrors staging's
 * same-dest collision rule (last write wins) so the set equals the manifest's
 * signatures exactly. Exists so profile-drift checks can run on every chat open /
 * input edit at stat/readdir cost, never content-size cost.
 *
 * A file that vanished between the walk and its stat is SKIPPED, not an error: the
 * database and the filesystem routinely disagree (a user may delete an input at any
 * moment), and the honest reading of a gone file is "this input is no longer here" —
 * which surfaces as drift and re-profiles. Failing parity outright would strand the
 * chat on an error the user cannot escape.
 *
 * @param analysisId - The analysis whose input identity space to enumerate.
 * @returns The signatures staging would emit, or a `DbError` (input listing / anchor
 *   resolution) or `StagingError` (a directory-input walk that hit an I/O fault).
 */
export function enumerateInputSignatures(analysisId: string): Result<ReadonlySet<string>, DbError | StagingError> {
    return walkInputFiles(analysisId).map((files) => {
        // Overlapping inputs can resolve to the same `relativePath`; staging keeps
        // the LAST such entry, so collapse identically here before collecting signatures —
        // otherwise a clash would surface a fileId the manifest dropped.
        const byPath = new Map<string, string>();
        for (const file of files) {
            const stats = statResult(file.absPath, "enumerateInputSignatures:stat");
            if (stats.isErr()) {
                getLogger("staging").warn({ absPath: file.absPath }, "input file disappeared between the walk and its stat — treating it as removed");
                continue;
            }
            byPath.set(file.relativePath, inputSignature(file.fileId, stats.value.size, stats.value.mtimeMs));
        }
        return new Set(byPath.values());
    });
}
