import type { Stats } from "node:fs";
import { copyFile, link, readdir, rm, rmdir, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ok, err, Result, ResultAsync } from "neverthrow";
import PQueue from "p-queue";
import type { AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { resolveInputPath } from "../analysis/input.ts";
import { sha256File } from "../../lib/hash.ts";
import { mkdirResultAsync, pathExistsAsync, pathsExistAsync, statResultAsync } from "../../lib/fs.ts";
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
    /** SHA-256 digest of the file content as `sha256:<hex>`, the form of every harness artifact hash. */
    readonly hash: string;
    /** File size in bytes. */
    readonly size: number;
    /** Source file's last-modification time, epoch ms. With `size` + `fileId`, it feeds the `inputSignature` audit record of a profile. */
    readonly mtimeMs: number;
    /** Path relative to the data dir: `inputs/{mountName}/{key}`. */
    readonly relativePath: string;
};

/**
 * Deterministic file identity from the input's anchor+path. Uses Bun.hash for
 * speed (non-crypto). For single-file inputs the hashed key (`anchorId|path`)
 * is the same key space as the kernel's `inputQName` (the `provModel` in
 * `modules/prov/document.ts` injects the same `Bun.hash` digest), so
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
 * preferred (fast, zero-copy, safe because the harness mounts the workspace tree
 * read-only into sandboxes); the copy fallback covers cross-filesystem boundaries.
 *
 * `srcStats` is the source's stat taken before placement — the same reading the manifest records —
 * and is consumed ONLY by the copy fallback's timestamp stamp (see the constraint at that call site).
 */
async function stageFile(src: string, dest: string, srcStats: Stats): Promise<Result<void, FsError>> {
    const made = await mkdirResultAsync(dirname(dest), "stageFile:mkdir");
    if (made.isErr()) return err(made.error);
    // Remove any stale destination before linking: re-staging must refresh, and a
    // stale dest is typically a hardlink OF src itself — `link` would fail EEXIST
    // and `copyFile` onto the same inode truncates the source before reading it
    // (libuv performs no same-file check), destroying the user's input.
    try {
        await rm(dest, { force: true });
    } catch (cause) {
        return err({ type: "io_failed", op: "stageFile:rm", cause });
    }
    try {
        await link(src, dest);
    } catch {
        try {
            await copyFile(src, dest);
        } catch (cause) {
            return err({ type: "io_failed", op: "stageFile:copy", cause });
        }
        // A copy carries its own creation time (measured: `copyFile` does not preserve the
        // source's mtime), and the staged tree is the ONLY record that an input set was
        // materialized — a record read by comparing size + mtime against the source. Without this
        // stamp a copy-mode analysis would read as permanently unmaterialized and re-hash forever.
        //
        // The stamp belongs to THIS branch alone. A hardlinked destination shares the source's
        // inode, so `utimes` on it rewrites the user's own input file (measured) — and since
        // {@link isInputSetMaterialized} compares that file's mtime against the staged copy's,
        // staging would manufacture a permanent mismatch against the tree it just wrote.
        // Seconds, not the `Date` fields: `utimes` takes an
        // f64 seconds value, and `mtimeMs / 1000` keeps far more of the sub-millisecond fraction
        // than a `Date` (which truncates to whole ms and misses every fractional mtime). It is still
        // NOT bit-exact — the seconds round-trip drops a few float-ULPs of the tail a nanosecond
        // filesystem reports (measured on APFS: ~90% of natural mtimes read back a fraction off, up
        // to 2^-10 ms) — which is exactly why {@link isInputSetMaterialized} compares mtimes within
        // {@link MTIME_MATCH_TOLERANCE_MS} rather than with `===`.
        try {
            await utimes(dest, srcStats.atimeMs / 1000, srcStats.mtimeMs / 1000);
        } catch (cause) {
            return err({ type: "io_failed", op: "stageFile:utimes", cause });
        }
    }
    return ok(undefined);
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
export const IGNORED_WALK_DIRS: ReadonlySet<string> = new Set([
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

/** The single flat mount every CLI-staged file lands under (`StagedInput.mountName`). */
const LOCAL_MOUNT_NAME = "local";

/**
 * The staged tree's root relative to the data dir: `inputs/{LOCAL_MOUNT_NAME}`. Three places derive
 * from this ONE value and compare the results against each other — the manifest's `relativePath`
 * ({@link walkInputFiles}), the reconcile walk's root ({@link reconcileStagedTree}), and the
 * already-materialized predicate ({@link isInputSetMaterialized}). A divergence between them is not a
 * type error: it makes the predicate compare a source against a staged path the manifest never wrote,
 * so it reports drift for a set that is in fact materialized. Structural coupling, not a comment-kept one.
 */
const LOCAL_MOUNT_SUBDIR = join("inputs", LOCAL_MOUNT_NAME);

/**
 * How many `readdir`, `stat`, `rm`, and `rmdir` calls one walk or one stat pass keeps in flight. The local
 * server runs staging for a request, thus a tree on a hung mount holds this many threads of the pool, not all.
 */
const METADATA_WIDTH = 16;

/**
 * How many files staging places and hashes at one time. Each slot holds one link or copy, or one streamed
 * hash, so a large input set neither runs one file at a time nor opens every file at once.
 */
const MATERIALIZE_WIDTH = 4;

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
 *
 * The reads run off the event loop, with at most {@link METADATA_WIDTH} in flight. The paths come back in
 * the order a depth-first walk of the `readdir` order gives, whatever order the reads complete in. The
 * first failed `readdir` fails the walk and drops the reads still queued.
 */
export function walkFiles(dir: string, ignoredDirs: ReadonlySet<string>): ResultAsync<string[], FsError> {
    const queue = new PQueue({ concurrency: METADATA_WIDTH });
    let failed = false;
    // The priority is the depth, so deeper work runs first and the walk drains one subtree before it
    // opens the next. The queue then holds about one listing for each level, as a recursive walk does,
    // and not the whole frontier of the tree.
    async function walk(path: string, depth: number): Promise<string[]> {
        if (failed) return [];
        const entries = await queue.add(() => readdir(path, { withFileTypes: true }), { priority: depth });
        const nested = await Promise.all(
            entries.map(async (entry): Promise<string[]> => {
                const full = join(path, entry.name);
                let isDirectory = entry.isDirectory();
                let isFile = entry.isFile();
                if (entry.isSymbolicLink()) {
                    const target = await queue.add(async () => statResultAsync(full, "walkFiles:stat"), { priority: depth + 1 });
                    if (target.isErr()) return [];
                    isDirectory = target.value.isDirectory();
                    isFile = target.value.isFile();
                }
                if (isDirectory) {
                    if (ignoredDirs.has(entry.name)) return [];
                    return (await walk(full, depth + 1)).map((sub) => join(entry.name, sub));
                }
                return isFile ? [entry.name] : [];
            }),
        );
        return nested.flat();
    }
    return ResultAsync.fromPromise(walk(dir, 0), (cause): FsError => {
        // The result is decided, thus the queued reads of the other subtrees are waste. A cleared task never
        // settles, which is safe: only the rejected walk waits on it.
        failed = true;
        queue.clear();
        return { type: "io_failed", op: "walkFiles", cause };
    });
}

/**
 * The write half of staging: take one walked {@link InputFile}, hash its content,
 * link/copy it into the target tree, and return its `StagedInput` manifest row.
 * {@link walkInputFiles} has already decided WHICH files exist and their identity
 * (`fileId`/`key`/`relativePath`); this only pays the content-size costs. Split out
 * so {@link enumerateInputPaths} can share the walk without any of them.
 */
async function materializeStagedFile(file: InputFile, targetDir: string): Promise<Result<StagedInput, FsError>> {
    // One stat yields both size and mtime, so the manifest agrees with what
    // {@link isInputSetMaterialized} later reads back off the same file. Taken BEFORE
    // placement so the copy fallback's timestamp stamp and the manifest record the same reading —
    // two stats straddling the copy could disagree, and the staged tree would then misreport the set
    // it materialized.
    const statsResult = await statResultAsync(file.absPath, "materializeStagedFile:stat");
    if (statsResult.isErr()) return err(statsResult.error);

    const dest = join(targetDir, file.relativePath);
    const stageResult = await stageFile(file.absPath, dest, statsResult.value);
    if (stageResult.isErr()) return err(stageResult.error);

    const hashResult = await sha256File(file.absPath);
    if (hashResult.isErr()) return err(hashResult.error);

    return ok({
        fileId: file.fileId,
        mountName: LOCAL_MOUNT_NAME,
        key: file.key,
        fileName: basename(file.absPath),
        hash: `sha256:${hashResult.value}`,
        size: statsResult.value.size,
        // Verbatim, fraction and all: this is the value the ledger records, and
        // {@link isInputSetMaterialized} compares it against a fresh `stat` of the same file.
        // Rounding here and not there — or the reverse — would make every analysis read as
        // permanently unmaterialized.
        mtimeMs: statsResult.value.mtimeMs,
        relativePath: file.relativePath,
    });
}

/** Staging-layer error: wraps I/O failures from the filesystem operations during staging. */
export type StagingError = { type: "staging_failed"; cause: unknown };

/**
 * Remove now-empty directories under `dir` (bottom-up), leaving `dir` itself in place. A directory is read
 * again only after each of its children is pruned, because a child that becomes empty and goes is what
 * can make its parent empty. At most {@link METADATA_WIDTH} reads and removals are in flight.
 */
function pruneEmptyDirs(dir: string): ResultAsync<void, FsError> {
    const queue = new PQueue({ concurrency: METADATA_WIDTH });
    // The depth priority keeps the queue to about one listing for each level, as in {@link walkFiles}.
    async function prune(path: string, depth: number): Promise<void> {
        const entries = await queue.add(() => readdir(path, { withFileTypes: true }), { priority: depth });
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    const full = join(path, entry.name);
                    await prune(full, depth + 1);
                    const left = await queue.add(() => readdir(full), { priority: depth + 1 });
                    if (left.length === 0) await queue.add(() => rmdir(full), { priority: depth + 1 });
                }),
        );
    }
    return ResultAsync.fromPromise(prune(dir, 0), (cause): FsError => ({ type: "io_failed", op: "pruneEmptyDirs", cause }));
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
async function reconcileStagedTree(targetDir: string, staged: StagedInput[]): Promise<Result<void, FsError>> {
    const localRoot = join(targetDir, LOCAL_MOUNT_SUBDIR);
    if (!(await pathExistsAsync(localRoot))) return ok(undefined);

    const existingResult = await walkFiles(localRoot, WALK_EVERYTHING);
    if (existingResult.isErr()) return err(existingResult.error);

    // Compare absolute path to absolute path — `join` normalizes both sides.
    // Comparing the walk's relative paths against manifest KEYS is wrong the
    // moment a key isn't a clean relative path (join collapses a leading slash
    // when writing, so key and on-disk path diverge and reconcile would delete
    // freshly staged files).
    const expected = new Set(staged.map((s) => join(targetDir, s.relativePath)));
    const stale = existingResult.value.map((rel) => join(localRoot, rel)).filter((abs) => !expected.has(abs));
    const queue = new PQueue({ concurrency: METADATA_WIDTH });
    try {
        await Promise.all(stale.map((abs) => queue.add(() => rm(abs, { force: true }))));
    } catch (cause) {
        return err({ type: "io_failed", op: "reconcileStagedTree:rm", cause });
    }
    return pruneEmptyDirs(localRoot);
}

/**
 * One file an input yields, its staging identity resolved but no content touched.
 * The unit both {@link stageInputs} and {@link enumerateInputPaths} consume:
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
 * and {@link enumerateInputPaths} adds nothing, so their identity spaces are
 * structurally unable to diverge.
 */
function walkInputFiles(analysisId: string): ResultAsync<InputFile[], DbError | StagingError> {
    return new ResultAsync(walkInputFilesAsync(analysisId));
}

async function walkInputFilesAsync(analysisId: string): Promise<Result<InputFile[], DbError | StagingError>> {
    const inputsResult = listAnalysisInputs(analysisId);
    if (inputsResult.isErr()) return err(inputsResult.error);

    // One input at a time: an anchored input can run a bounded search of its own.
    const resolvedInputs: { input: AnalysisInput; absPath: string }[] = [];
    for (const input of inputsResult.value) {
        const absPath = await resolveInputPath(input);
        if (absPath.isErr()) return err(absPath.error);
        if (absPath.value !== null) resolvedInputs.push({ input, absPath: absPath.value });
    }

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
    const present = await pathsExistAsync(
        resolvedInputs.map(({ absPath }) => absPath),
        METADATA_WIDTH,
    );
    const files: InputFile[] = [];
    // One directory walk at a time: each walk keeps its own fixed-width queue, so parallel walks would multiply
    // the bound by the count of directory inputs.
    for (const [index, { input, absPath }] of resolvedInputs.entries()) {
        if (!present[index]) {
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
            const walkResult = await walkFiles(absPath, IGNORED_WALK_DIRS);
            if (walkResult.isErr()) return err({ type: "staging_failed", cause: walkResult.error });
            for (const subpath of walkResult.value) {
                const key = join(keyRoot, subpath);
                files.push({ input, absPath: join(absPath, subpath), key, fileId: deriveFileId(input, subpath), relativePath: join(LOCAL_MOUNT_SUBDIR, key) });
            }
        } else {
            files.push({ input, absPath, key: keyRoot, fileId: deriveFileId(input), relativePath: join(LOCAL_MOUNT_SUBDIR, keyRoot) });
        }
    }
    return ok(files);
}

/**
 * Resolve an analysis's inputs to absolute paths, copy/link them into a staging tree,
 * compute content hashes, and return the `StagedInput[]` manifest the harness consumes.
 *
 * @param analysisId - The analysis whose inputs to stage.
 * @param targetDir - The data directory root (`workspaceDataDir(analysis)` — see
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
    const filesResult = await walkInputFiles(analysisId);
    if (filesResult.isErr()) return err(filesResult.error);

    // Overlapping inputs stage to the SAME dest path: a directory input plus a
    // file input inside it, or two anchors whose subtrees share a relative path.
    // The files of one dest stage in walk order, one after the other, never at the
    // same time: two concurrent placements race on the dest, and a `link` that loses
    // with EEXIST falls back to `copyFile` onto a hardlink of the same source, which
    // truncates the user's input. Distinct dests stage in parallel.
    //
    // In order, the last writer's bytes stay on disk, and two manifest entries with
    // one `relativePath` would break the harness's multi-row artifact upsert —
    // Postgres rejects two rows that hit the same ON CONFLICT key in a single
    // statement. Thus each dest keeps its LAST entry, so the manifest matches what is
    // actually on disk; warn only when the dropped entry held DIFFERENT content (a
    // genuine input clash, not the benign dir-holds-file overlap where both resolve
    // to the same source).
    const byDest = new Map<string, [InputFile, ...InputFile[]]>();
    for (const file of filesResult.value) {
        const group = byDest.get(file.relativePath);
        if (group) group.push(file);
        else byDest.set(file.relativePath, [file]);
    }

    // After a failure the result is decided, thus a group that has not started stages nothing.
    let failed = false;
    async function stageDest([first, ...rest]: readonly [InputFile, ...InputFile[]]): Promise<Result<StagedInput, FsError> | null> {
        if (failed) return null;
        let kept = await materializeStagedFile(first, targetDir);
        for (const file of rest) {
            if (kept.isErr() || failed) break;
            const next = await materializeStagedFile(file, targetDir);
            if (next.isOk() && kept.value.hash !== next.value.hash) {
                getLogger("staging").warn(
                    { relativePath: next.value.relativePath, droppedKey: kept.value.key, keptKey: next.value.key },
                    "two inputs stage to the same path with different content — keeping the last-staged file",
                );
            }
            kept = next;
        }
        if (kept.isErr()) failed = true;
        return kept;
    }

    const queue = new PQueue({ concurrency: MATERIALIZE_WIDTH });
    const outcomes = await Promise.all([...byDest.values()].map((group) => queue.add(() => stageDest(group))));
    const uniqueStaged: StagedInput[] = [];
    for (const outcome of outcomes) {
        if (outcome === null) continue;
        if (outcome.isErr()) return err({ type: "staging_failed", cause: outcome.error });
        uniqueStaged.push(outcome.value);
    }

    const reconcileResult = await reconcileStagedTree(targetDir, uniqueStaged);
    if (reconcileResult.isErr()) return err({ type: "staging_failed", cause: reconcileResult.error });

    return ok(uniqueStaged);
}

/**
 * The read-only, hash-free twin of {@link stageInputs}: the set of analysis-relative
 * paths staging would produce for `analysisId`, without touching content (no
 * `sha256File`), linking, copying, or writing the session tree — which need not even
 * exist. Both funnel through {@link walkInputFiles}, so the two cannot disagree about
 * which files an analysis has; the dedup by `relativePath` mirrors staging's same-dest
 * collision rule (last write wins) so the set equals the manifest's paths exactly.
 *
 * It answers one question — DOES this analysis have inputs on disk right now — which is
 * what the profile ladder branches on (an emptied set clears the profile; a non-empty one
 * is materialized). It deliberately carries no size or mtime: a profile is re-invoked on
 * the input-mutation edge, not derived as stale from a comparison here, so a per-file
 * drift signature would be gathered for no reader.
 *
 * A file that vanished between the walk and its stat is SKIPPED, not an error: the
 * database and the filesystem routinely disagree (a user may delete an input at any
 * moment), and the honest reading of a gone file is "this input is no longer here".
 * Failing outright would strand the chat on an error the user cannot escape.
 *
 * @param analysisId - The analysis whose input paths to enumerate.
 * @returns The analysis-relative paths staging would write, or a `DbError` (input listing /
 *   anchor resolution) or `StagingError` (a directory-input walk that hit an I/O fault).
 */
export function enumerateInputPaths(analysisId: string): ResultAsync<ReadonlySet<string>, DbError | StagingError> {
    return walkInputFiles(analysisId).map(async (files) => {
        const exists = await pathsExistAsync(
            files.map((file) => file.absPath),
            METADATA_WIDTH,
        );
        // Overlapping inputs can resolve to the same `relativePath`; staging keeps the LAST
        // such entry, and a Set on that key collapses them identically.
        const present = new Set<string>();
        for (const [index, file] of files.entries()) {
            if (!exists[index]) {
                getLogger("staging").warn({ absPath: file.absPath }, "input file disappeared between the walk and its stat — treating it as removed");
                continue;
            }
            present.add(file.relativePath);
        }
        return present;
    });
}

/**
 * The largest gap between two `mtimeMs` readings still treated as the same modification instant.
 *
 * The copy fallback stamps the source's mtime onto the destination with `utimesSync` ({@link stageFile}),
 * which takes an f64 seconds value: the sub-millisecond tail a nanosecond-granularity filesystem reports
 * (`…704.7327`) does not survive the ms → seconds → `timespec` → ms round-trip and reads back a few
 * float-ULPs short (`…704.732`). An exact `===` therefore reported ~90% of copy-staged files as drifted
 * on APFS (measured), re-hashing genomics-sized inputs on every parity check for nothing. Measured drift
 * topped out at 2^-10 ms; the error is a few ULPs of the f64 mtime grid (~2^-11 ms/ULP at epoch-ms
 * scale, and the grid coarsens as the timestamp grows), so this is set to 2^-6 ms — ample headroom over
 * that across filesystems and future timestamps, yet still ~64× finer than a millisecond and orders of
 * magnitude below any real edit's mtime delta (a rewrite stamps wall-clock "now", seconds-to-hours after
 * staging). So it never masks a genuine change; only a coarse (whole-second) filesystem drifts past it,
 * and there the predicate merely re-stages, the safe direction. Hardlinked files share the source inode
 * and match at a zero gap.
 */
const MTIME_MATCH_TOLERANCE_MS = 2 ** -6;

/**
 * Whether two `mtimeMs` readings denote the same modification instant, within the copy-stamp round-trip
 * tolerance ({@link MTIME_MATCH_TOLERANCE_MS}). Exported for the round-trip test, which pins real APFS
 * drift values a live copy is hard to reproduce deterministically in a same-filesystem temp dir.
 */
export function mtimesMatch(a: number, b: number): boolean {
    return Math.abs(a - b) <= MTIME_MATCH_TOLERANCE_MS;
}

/**
 * Whether `analysisId`'s current input set already exists under `targetDir` exactly as
 * {@link stageInputs} would leave it — "is there anything to materialize?", answered at stat/readdir
 * cost like {@link enumerateInputPaths}, never at content cost.
 *
 * The staged tree IS the record of what was materialized, so nothing else has to be kept: a staged
 * file carries its source's size and mtime by construction (a hardlink shares the source's inode; the
 * copy fallback stamps it — see {@link stageFile}), which makes "same file, same bytes" answerable from
 * two stats. A separate marker file was rejected for adding a format, an atomicity question, and a
 * whole class of record-versus-tree disagreement to a question the tree already answers. Built on
 * {@link walkInputFiles}, the same walk staging expands, so the expected set cannot diverge from what
 * staging would produce.
 *
 * Conservative in ONE direction: a missing staged file, a size or mtime mismatch, an unreadable path,
 * or a staged file no current input produces (staging's mirror pass would delete it) all read as
 * `false`. The worst outcome is a redundant staging pass; a `true` for a set that is not fully present
 * and current is unrepresentable. mtime is matched within {@link MTIME_MATCH_TOLERANCE_MS}, not by
 * `===`, because the copy fallback's stamp does not round-trip bit-exact; the tolerance is far below any
 * real edit's mtime delta, so it never manufactures a false `true` for a genuinely changed file — see
 * that constant. The error channel carries only the walk's own faults — input listing, anchor
 * resolution, a directory-input walk — exactly as enumeration reports them.
 *
 * @param analysisId - The analysis whose current input set to check.
 * @param targetDir - The data directory root staging writes under (`workspaceDataDir(analysis)`).
 */
export function isInputSetMaterialized(analysisId: string, targetDir: string): ResultAsync<boolean, DbError | StagingError> {
    return walkInputFiles(analysisId).map(async (files) => {
        // Overlapping inputs can resolve to one `relativePath`; staging keeps the LAST entry, so the
        // expected tree is that same collapse — comparing against the dropped entry's source would
        // report a mismatch for a path the manifest never claimed.
        const expected = new Map<string, InputFile>();
        for (const file of files) expected.set(file.relativePath, file);

        // One mismatch decides the answer, thus a pair that has not started stats nothing after it.
        let mismatch = false;
        const queue = new PQueue({ concurrency: METADATA_WIDTH });
        async function matches(relativePath: string, file: InputFile): Promise<boolean> {
            const srcStats = await statResultAsync(file.absPath, "isInputSetMaterialized:src");
            if (srcStats.isErr()) return false;
            const stagedStats = await statResultAsync(join(targetDir, relativePath), "isInputSetMaterialized:staged");
            if (stagedStats.isErr()) return false;
            return stagedStats.value.size === srcStats.value.size && mtimesMatch(stagedStats.value.mtimeMs, srcStats.value.mtimeMs);
        }
        await Promise.all(
            [...expected].map(([relativePath, file]) =>
                queue.add(async () => {
                    if (!mismatch && !(await matches(relativePath, file))) mismatch = true;
                }),
            ),
        );
        if (mismatch) return false;

        // A staged file no current input yields means the mirror pass has deletions to perform, which
        // is work — so the set is not materialized as staging would leave it. The walk passes no ignore
        // set, exactly as `reconcileStagedTree` does: it must see files staged under names the staging
        // walk now skips, since those are precisely the ones reconciliation would remove.
        const localRoot = join(targetDir, LOCAL_MOUNT_SUBDIR);
        if (!(await pathExistsAsync(localRoot))) return expected.size === 0;
        const existingResult = await walkFiles(localRoot, WALK_EVERYTHING);
        if (existingResult.isErr()) return false;
        // Absolute-vs-absolute, the comparison `reconcileStagedTree` makes for the same reason: a
        // manifest key is not always a clean relative path, so only `join`ed absolutes agree.
        const expectedPaths = new Set([...expected.keys()].map((relativePath) => join(targetDir, relativePath)));
        for (const rel of existingResult.value) {
            if (!expectedPaths.has(join(localRoot, rel))) return false;
        }
        return true;
    });
}
