import type { Dirent, Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { access, copyFile, link, lstat, readdir, realpath, rm, rmdir, stat, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { quarantineReason } from "@inflexa-ai/harness/input-scan/quarantine.js";
import { randomUUIDv7 } from "bun";
import { ok, err, Result, ResultAsync } from "neverthrow";
import PQueue from "p-queue";
import type { AnalysisInput } from "../../types/analysis.ts";
import type { DbError } from "../../db/errors.ts";
import { listAnalysisInputs } from "../../db/primary_query.ts";
import { resolveInputPath } from "../analysis/input.ts";
import { errnoCode, mkdirResultAsync, pathExistsAsync, pathsExistAsync, statResultAsync } from "../../lib/fs.ts";
import type { FsError } from "../../lib/fs.ts";
import { getLogger } from "../../lib/log.ts";

/**
 * One input file staged under the analysis data dir. Shape matches the harness's `StagedInput`
 * (`@inflexa-ai/harness`, src/execution/staged-input.ts) field-for-field. Staging reads no content:
 * the record holds what one `stat` gives.
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
    /** File size in bytes. */
    readonly size: number;
    /** Source file's last-modification time, epoch ms. With `size` + `fileId`, it feeds the `inputSignature` audit record of a profile. */
    readonly mtimeMs: number;
    /** Path relative to the data dir: `inputs/{mountName}/{key}`. */
    readonly relativePath: string;
};

/**
 * What one staging pass did. `warnings` names each source that staging could not read and each input whose
 * source is not reachable now: a pass skips such a source and keeps the files that an earlier pass staged
 * for it, and it does not fail.
 */
export type StagingOutcome = {
    readonly staged: StagedInput[];
    readonly warnings: string[];
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
 * What {@link stageFile} did: `placed` linked or copied the source, `kept` found the destination already a
 * hardlink of the source or a copy with the same size and mtime, and `unreadable` found a source that it
 * cannot read, and left the destination as it was.
 */
type Placement = "placed" | "kept" | "unreadable";

/**
 * Link a file into the staging tree. Hardlinks are preferred (fast, zero-copy, safe because the harness mounts the
 * workspace tree read-only into sandboxes); the copy fallback covers cross-filesystem boundaries.
 *
 * A destination that is already a hardlink of the source (the same `dev` and `ino`), or a copy with the same size and
 * mtime, stays as it is: a staging pass over an unchanged set then writes nothing. The link names the real path of
 * the source, because `link(2)` on Linux does not follow a symlink, and a staged symlink names a path the sandbox
 * cannot resolve.
 *
 * `srcStats` is the source's stat taken before placement — the same reading the manifest records — and is consumed
 * by the unchanged-destination test and by the copy fallback's timestamp stamp (see the constraint at that call site).
 */
async function stageFile(src: string, dest: string, srcStats: Stats): Promise<Result<Placement, FsError>> {
    const made = await mkdirResultAsync(dirname(dest), "stageFile:mkdir");
    if (made.isErr()) return err(made.error);
    const existing = await lstat(dest).then(
        (stats) => stats,
        () => null,
    );
    if (existing !== null) {
        if (existing.dev === srcStats.dev && existing.ino === srcStats.ino) return ok("kept");
        if (existing.isFile() && existing.size === srcStats.size && mtimesMatch(existing.mtimeMs, srcStats.mtimeMs)) return ok("kept");
    }
    // The source is read before the destination goes: a source that cannot be read keeps the staged copy of an
    // earlier pass, which the caller then carries.
    const real = await realpath(src).then(
        (path) => path,
        () => null,
    );
    if (real === null) return ok("unreadable");
    const readable = await access(real, fsConstants.R_OK).then(
        () => true,
        () => false,
    );
    if (!readable) return ok("unreadable");
    // Remove any stale destination before linking: re-staging must refresh, and a stale dest can be a hardlink of an
    // earlier version of the source — `link` would fail EEXIST, and `copyFile` onto a hardlink of the source itself
    // truncates the source before reading it (libuv performs no same-file check), destroying the user's input. The
    // same-inode test above keeps the common case out of here, and the `rm` keeps the rest safe.
    try {
        await rm(dest, { force: true });
    } catch (cause) {
        return err({ type: "io_failed", op: "stageFile:rm", cause });
    }
    try {
        await link(real, dest);
    } catch {
        try {
            await copyFile(real, dest);
        } catch (cause) {
            return err({ type: "io_failed", op: "stageFile:copy", cause });
        }
        // A copy carries its own creation time (measured: `copyFile` does not preserve the
        // source's mtime), and the staged tree is the ONLY record that an input set was
        // materialized — a record read by comparing size + mtime against the source. Without this
        // stamp a copy-mode analysis would read as permanently unmaterialized and re-copy forever.
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
    return ok("placed");
}

/**
 * Directory names a directory-input walk never descends into. The first group
 * mirrors the harness's sandbox-side `IGNORED_DIRS` (`sandbox/ignored-dirs.ts`)
 * so what staging materializes matches what the harness's own walks treat as
 * data. The second group is cli-specific: source control and the anchor-marker
 * dir show up whenever a user selects a project root as a directory input, and
 * are never analysis data. The third group holds the scratch trees of the workflow
 * engines (Nextflow `work`, `.nextflow`, `.snakemake`) and the macOS archive
 * droppings (`__MACOSX`): each can hold more files than the data beside it. Kept
 * as a cli-owned constant (not imported from the harness) because the lists answer
 * different questions — runtime tool noise vs. what counts as user data — and only
 * happen to overlap today.
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
    "work",
    ".nextflow",
    ".snakemake",
    "__MACOSX",
]);

/** Which entries a walk leaves out. */
export type WalkFilter = {
    /** Directory names the walk does not descend into. */
    readonly ignoredDirs: ReadonlySet<string>;
    /** Leave out each name that the harness quarantines (`quarantineReason`): AppleDouble files, partial downloads, and others. */
    readonly quarantine: boolean;
};

/**
 * The filter of each walk over the source of an input, and over the files staging keeps for it. Staging, the
 * enumeration, and the materialized check share it through {@link walkInputFiles}, thus they agree on the set.
 */
export const STAGING_WALK_FILTER: WalkFilter = { ignoredDirs: IGNORED_WALK_DIRS, quarantine: true };

const WALK_EVERYTHING: WalkFilter = { ignoredDirs: new Set(), quarantine: false };

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
 * How many `readdir`, `stat`, `rm`, and `rmdir` calls one walk or one stat pass keeps in flight. A tree on a hung
 * mount holds this many threads of the file pool of its process, for as long as the mount hangs. The local server
 * runs staging for a request. A detached server, and a foreground server outside Windows, request a pool of at least
 * 64 threads, thus the other file calls of the server keep their threads. A pool size that the person sets, and a
 * foreground server on Windows, keep their own pool. A person-run `inflexa run` keeps the pool of its own process.
 * When that pool has 16 threads or fewer, 16 hung calls can hold each thread of it.
 */
const METADATA_WIDTH = 16;

/**
 * How many files staging places at one time. Each slot holds one link or copy, so a large input set neither runs one
 * file at a time nor opens every file at once.
 */
const MATERIALIZE_WIDTH = 4;

/** The files a walk found, and the entries it could not read. */
export type WalkResult = {
    /** Paths relative to the walked directory, in the depth-first `readdir` order. */
    readonly files: string[];
    /** Paths relative to the walked directory that the walk could not read. `""` is the walked directory itself. */
    readonly skipped: string[];
};

/**
 * Recursively enumerate all files under `dir`, returning paths relative to `dir`.
 * Directories are traversed, not yielded; the `filter` leaves out ignored directories
 * and, when it asks for it, the names the harness quarantines (staging passes
 * {@link STAGING_WALK_FILTER}; the reconcile pass passes no filter — it must see files
 * staged under names that are ignored NOW but were not when they were staged). Dirent
 * kind checks answer false for symlinks on both `isFile()` and `isDirectory()`, so
 * symlink entries are stat-resolved explicitly: a link to a file is yielded, a link to
 * a directory is traversed, and a dangling link is skipped — an unreadable target is a
 * property of the user's source tree, not a staging failure.
 *
 * A directory is entered once for each `(dev, ino)`, thus a symlink that points back up the tree ends the descent
 * instead of looping. An entry that cannot be read (`EACCES`, `EIO`, and others) is skipped and named in
 * `skipped`; a path that vanished during the walk (`ENOENT`) is skipped silently.
 *
 * The reads run off the event loop, with at most {@link METADATA_WIDTH} in flight. The paths come back in
 * the order a depth-first walk of the `readdir` order gives, whatever order the reads complete in.
 */
export async function walkFiles(dir: string, filter: WalkFilter): Promise<WalkResult> {
    const queue = new PQueue({ concurrency: METADATA_WIDTH });
    const visited = new Set<string>();
    const skipped: string[] = [];
    function skip(rel: string, cause: unknown): void {
        if (errnoCode(cause) !== "ENOENT") skipped.push(rel);
    }
    // The priority is the depth, so deeper work runs first and the walk drains one subtree before it
    // opens the next. The queue then holds about one listing for each level, as a recursive walk does,
    // and not the whole frontier of the tree.
    async function walk(path: string, rel: string, depth: number, self: Stats): Promise<string[]> {
        const identity = `${self.dev}:${self.ino}`;
        if (visited.has(identity)) return [];
        visited.add(identity);
        let entries: Dirent[];
        try {
            entries = await queue.add(() => readdir(path, { withFileTypes: true }), { priority: depth });
        } catch (cause) {
            skip(rel, cause);
            return [];
        }
        const nested = await Promise.all(
            entries.map(async (entry): Promise<string[]> => {
                const full = join(path, entry.name);
                const entryRel = join(rel, entry.name);
                const isLink = entry.isSymbolicLink();
                if (!isLink && !entry.isDirectory()) {
                    if (!entry.isFile()) return [];
                    return filter.quarantine && quarantineReason(entry.name) !== undefined ? [] : [entry.name];
                }
                let target: Stats;
                try {
                    target = await queue.add(() => stat(full), { priority: depth + 1 });
                } catch (cause) {
                    skip(entryRel, cause);
                    return [];
                }
                if (target.isDirectory()) {
                    if (filter.ignoredDirs.has(entry.name)) return [];
                    if (filter.quarantine && quarantineReason(entry.name) !== undefined) return [];
                    return (await walk(full, entryRel, depth + 1, target)).map((sub) => join(entry.name, sub));
                }
                if (!target.isFile()) return [];
                return filter.quarantine && quarantineReason(entry.name) !== undefined ? [] : [entry.name];
            }),
        );
        return nested.flat();
    }
    let root: Stats;
    try {
        root = await stat(dir);
    } catch (cause) {
        skip("", cause);
        return { files: [], skipped };
    }
    const files = await walk(dir, "", 0, root);
    return { files, skipped };
}

/**
 * The write half of staging: take one walked {@link InputFile}, link/copy it into the target tree, and return its
 * `StagedInput` manifest row. {@link walkInputFiles} has already decided WHICH files exist and their identity
 * (`fileId`/`key`/`relativePath`); this only pays the placement. `unreadable` is a source that this pass cannot read.
 */
async function materializeStagedFile(file: InputFile, targetDir: string): Promise<Result<StagedInput | "unreadable", FsError>> {
    // One stat yields both size and mtime, so the manifest agrees with what
    // {@link isInputSetMaterialized} later reads back off the same file. Taken BEFORE
    // placement so the copy fallback's timestamp stamp and the manifest record the same reading —
    // two stats straddling the copy could disagree, and the staged tree would then misreport the set
    // it materialized.
    const statsResult = await statResultAsync(file.absPath, "materializeStagedFile:stat");
    if (statsResult.isErr()) return ok("unreadable");

    const dest = join(targetDir, file.relativePath);
    const stageResult = await stageFile(file.absPath, dest, statsResult.value);
    if (stageResult.isErr()) return err(stageResult.error);
    if (stageResult.value === "unreadable") return ok("unreadable");
    return ok(stagedInputOf(file, statsResult.value));
}

function stagedInputOf(file: InputFile, stats: Stats): StagedInput {
    return {
        fileId: file.fileId,
        mountName: LOCAL_MOUNT_NAME,
        key: file.key,
        fileName: basename(file.key),
        size: stats.size,
        // Verbatim, fraction and all: this is the value the ledger records, and
        // {@link isInputSetMaterialized} compares it against a fresh `stat` of the same file.
        // Rounding here and not there — or the reverse — would make every analysis read as
        // permanently unmaterialized.
        mtimeMs: stats.mtimeMs,
        relativePath: file.relativePath,
    };
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
 * cleanup can never key on (the input row is deleted, an ignore rule newly
 * excludes a subtree). The walk here passes no filter: it must see files
 * staged under names the staging walk now skips, or they would linger forever.
 * A source that is not reachable now keeps its staged files, because the walk
 * carries them into the manifest (see {@link walkInputFiles}).
 */
async function reconcileStagedTree(targetDir: string, staged: StagedInput[]): Promise<Result<void, FsError>> {
    const localRoot = join(targetDir, LOCAL_MOUNT_SUBDIR);
    if (!(await pathExistsAsync(localRoot))) return ok(undefined);

    const existing = await walkFiles(localRoot, WALK_EVERYTHING);

    // Compare absolute path to absolute path — `join` normalizes both sides.
    // Comparing the walk's relative paths against manifest KEYS is wrong the
    // moment a key isn't a clean relative path (join collapses a leading slash
    // when writing, so key and on-disk path diverge and reconcile would delete
    // freshly staged files).
    const expected = new Set(staged.map((s) => join(targetDir, s.relativePath)));
    const stale = existing.files.map((rel) => join(localRoot, rel)).filter((abs) => !expected.has(abs));
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
    /** Absolute path of this file on the host: the source, or the staged copy that a pass keeps for a source it cannot reach. */
    readonly absPath: string;
    /** Relative key within the `local` mount (directory members carry their subpath). */
    readonly key: string;
    /** Deterministic identity from {@link deriveFileId} — the space provenance also uses. */
    readonly fileId: string;
    /** Dest path relative to the data dir: `inputs/local/{key}`. */
    readonly relativePath: string;
};

/**
 * A part of an input whose source this pass cannot read: an input root that is not reachable, or an entry of a
 * directory input that the walk skipped. `subpath` is the part within a directory input (`""` for the whole input),
 * and `null` for a file input.
 */
type KeptPart = { readonly input: AnalysisInput; readonly keyRoot: string; readonly subpath: string | null };

/** The files of the current input set, and the warnings about the sources that the walk could not read or reach. */
type WalkedInputs = {
    readonly files: InputFile[];
    readonly warnings: string[];
    /** The count of inputs whose source is not reachable now. */
    readonly unreachable: number;
};

/**
 * The shared read-only walk under staging, the enumeration, and the materialized check: list the analysis's inputs,
 * resolve each to an absolute path, then expand every input into the files it yields — a directory input walks its
 * subtree via {@link walkFiles} under {@link STAGING_WALK_FILTER}; a file input yields itself unless the harness
 * quarantines its name. Cost is bounded by stat/readdir: no content reads, no tree writes. This is the SINGLE source
 * of "which files an input yields", so the identity spaces of its callers are structurally unable to diverge.
 *
 * Two cases look alike on disk and are not the same. An input row that the user removed is not listed, and its staged
 * files go at the next staging pass. An input whose source is not reachable now — an unmounted volume, an anchor
 * folder that cannot be located, a source that cannot be read — still names its files: the walk carries the copies
 * that an earlier pass staged under `dataDir`, and it names the source in `warnings`. Thus an unmounted drive neither
 * deletes the staged tree nor empties the input set and clears the profile. With `dataDir` `null`, nothing is carried.
 */
function walkInputFiles(analysisId: string, dataDir: string | null): ResultAsync<WalkedInputs, DbError> {
    return new ResultAsync(walkInputFilesAsync(analysisId, dataDir));
}

async function walkInputFilesAsync(analysisId: string, dataDir: string | null): Promise<Result<WalkedInputs, DbError>> {
    const inputsResult = listAnalysisInputs(analysisId);
    if (inputsResult.isErr()) return err(inputsResult.error);

    // One input at a time: an anchored input can run a bounded search of its own.
    const resolvedInputs: { input: AnalysisInput; absPath: string | null }[] = [];
    for (const input of inputsResult.value) {
        const absPath = await resolveInputPath(input);
        if (absPath.isErr()) return err(absPath.error);
        resolvedInputs.push({ input, absPath: absPath.value });
    }

    // Resolve existence ONCE, in the walk each caller shares, so the callers can never disagree about whether a
    // source is reachable.
    const present = await pathsExistAsync(
        resolvedInputs.map(({ absPath }) => absPath ?? ""),
        METADATA_WIDTH,
    );
    const files: InputFile[] = [];
    const kept: KeptPart[] = [];
    const warnings: string[] = [];
    let unreachable = 0;
    // One directory walk at a time: each walk keeps its own fixed-width queue, so parallel walks would multiply
    // the bound by the count of directory inputs.
    for (const [index, { input, absPath }] of resolvedInputs.entries()) {
        // Anchored inputs keep their human-readable anchor-relative path as the
        // key. Anchorless inputs carry an ABSOLUTE host path — used verbatim it
        // leaks the host filesystem into the sandbox layout and the agent
        // prompt, and `join` silently collapses its leading slash so the
        // on-disk path no longer matches the key. They stage under a stable
        // fileId-prefixed basename instead (collision-free across same-named
        // files from different locations, deterministic across runs).
        const keyRoot = input.anchorId === null ? join(deriveFileId(input), basename(input.path)) : input.path;
        if (absPath === null || !present[index]) {
            getLogger("staging").warn({ absPath, path: input.path }, "input source not reachable — keeping its staged files");
            warnings.push(`${absPath ?? input.path} is not reachable now; its staged files stay`);
            unreachable++;
            kept.push({ input, keyRoot, subpath: input.isDir ? "" : null });
            continue;
        }
        if (input.isDir) {
            const walked = await walkFiles(absPath, STAGING_WALK_FILTER);
            for (const subpath of walked.files) {
                const key = join(keyRoot, subpath);
                files.push({ input, absPath: join(absPath, subpath), key, fileId: deriveFileId(input, subpath), relativePath: join(LOCAL_MOUNT_SUBDIR, key) });
            }
            for (const subpath of walked.skipped) {
                warnings.push(`could not read ${join(absPath, subpath)}; staging skipped it`);
                kept.push({ input, keyRoot, subpath });
            }
        } else if (quarantineReason(basename(absPath)) === undefined) {
            files.push({ input, absPath, key: keyRoot, fileId: deriveFileId(input), relativePath: join(LOCAL_MOUNT_SUBDIR, keyRoot) });
        }
    }
    // The kept copies go first: when a source file and a kept copy name one destination, the dedup of each caller
    // keeps the last entry, which is the source.
    const carried = dataDir === null ? [] : await keptStagedFiles(dataDir, kept);
    return ok({ files: [...carried, ...files], warnings, unreachable });
}

/** The staged files under each kept part, as {@link InputFile}s whose `absPath` is the staged copy itself. */
async function keptStagedFiles(dataDir: string, parts: readonly KeptPart[]): Promise<InputFile[]> {
    const files: InputFile[] = [];
    for (const part of parts) {
        const partKey = part.subpath === null ? part.keyRoot : join(part.keyRoot, part.subpath);
        const stagedPath = join(dataDir, LOCAL_MOUNT_SUBDIR, partKey);
        const stats = await stat(stagedPath).then(
            (s) => s,
            () => null,
        );
        if (stats === null) continue;
        if (stats.isFile()) {
            const fileId = part.subpath === null ? deriveFileId(part.input) : deriveFileId(part.input, part.subpath);
            files.push({ input: part.input, absPath: stagedPath, key: partKey, fileId, relativePath: join(LOCAL_MOUNT_SUBDIR, partKey) });
            continue;
        }
        if (!stats.isDirectory()) continue;
        const walked = await walkFiles(stagedPath, STAGING_WALK_FILTER);
        for (const rel of walked.files) {
            const subpath = join(part.subpath ?? "", rel);
            const key = join(part.keyRoot, subpath);
            files.push({ input: part.input, absPath: join(stagedPath, rel), key, fileId: deriveFileId(part.input, subpath), relativePath: join(LOCAL_MOUNT_SUBDIR, key) });
        }
    }
    return files;
}

/** The progress of each staging pass that runs, by analysis: the destinations placed, of the total. */
const progressByAnalysis = new Map<string, { done: number; total: number }>();

/** The progress of the staging pass of the analysis, or `null` when none runs. `GET {A}/data-profile` reports it. */
export function stagingProgress(analysisId: string): { readonly done: number; readonly total: number } | null {
    const progress = progressByAnalysis.get(analysisId);
    return progress === undefined ? null : { ...progress };
}

/**
 * Resolve an analysis's inputs to absolute paths, link/copy them into a staging tree, and return the `StagedInput[]`
 * manifest. Staging reads no file content: the manifest holds what a `stat` gives, and a destination that already
 * holds the source stays as it is.
 *
 * @param analysisId - The analysis whose inputs to stage.
 * @param targetDir - The data directory root (`workspaceDataDir(analysis)` — see
 *   paths.ts). Staged files are written under `{targetDir}/inputs/local/{key}`; do NOT
 *   pass a path already ending in `inputs` or the tree doubles the segment.
 * @returns The staged manifest and the warnings, or a `DbError`/`StagingError` if resolution or a write fails.
 *   A source that cannot be read or reached is not a failure: the outcome names it, and the manifest keeps its
 *   earlier staged copy (see {@link walkInputFiles}).
 *
 * The staged tree MIRRORS the current inputs: files under `inputs/local` that no
 * current input produced are deleted and emptied directories pruned, so removing
 * an input (or an ignore rule newly excluding a subtree) cleans up on the next run.
 */
export async function stageInputs(analysisId: string, targetDir: string): Promise<Result<StagingOutcome, DbError | StagingError>> {
    const walkedResult = await walkInputFiles(analysisId, targetDir);
    if (walkedResult.isErr()) return err(walkedResult.error);
    const { files, warnings } = walkedResult.value;

    // Overlapping inputs stage to the SAME dest path: a directory input plus a
    // file input inside it, or two anchors whose subtrees share a relative path.
    // The files of one dest stage in walk order, one after the other, never at the
    // same time: two concurrent placements race on the dest, and a `link` that loses
    // with EEXIST falls back to `copyFile` onto a hardlink of the same source, which
    // truncates the user's input. Distinct dests stage in parallel.
    //
    // In order, the last writer's bytes stay on disk, and the manifest keeps the LAST
    // entry of each dest, so it matches what is actually on disk. Warn only when the
    // dropped entry has a DIFFERENT size or mtime (a genuine input clash, not the benign
    // dir-holds-file overlap where both resolve to the same source).
    const byDest = new Map<string, [InputFile, ...InputFile[]]>();
    for (const file of files) {
        const group = byDest.get(file.relativePath);
        if (group) group.push(file);
        else byDest.set(file.relativePath, [file]);
    }

    const progress = { done: 0, total: byDest.size };
    progressByAnalysis.set(analysisId, progress);
    try {
        // After a failure the result is decided, thus a group that has not started stages nothing.
        let failed = false;
        // A function reads the flag: concurrent groups set it while this one awaits, which narrowing cannot see.
        const hasFailed = (): boolean => failed;
        async function stageDest(group: readonly [InputFile, ...InputFile[]]): Promise<Result<StagedInput | null, FsError> | null> {
            if (hasFailed()) return null;
            let kept: StagedInput | null = null;
            for (const file of group) {
                if (hasFailed()) break;
                const next = await materializeStagedFile(file, targetDir);
                if (next.isErr()) {
                    failed = true;
                    return err(next.error);
                }
                if (next.value === "unreadable") {
                    warnings.push(`could not read ${file.absPath}; staging skipped it`);
                    continue;
                }
                if (kept !== null && (kept.size !== next.value.size || !mtimesMatch(kept.mtimeMs, next.value.mtimeMs))) {
                    getLogger("staging").warn(
                        { relativePath: next.value.relativePath, droppedKey: kept.key, keptKey: next.value.key },
                        "two inputs stage to the same path with different content — keeping the last-staged file",
                    );
                }
                kept = next.value;
            }
            // A source this pass cannot read keeps the copy that an earlier pass staged, so reconcile leaves it.
            if (kept === null) kept = await keptCopyOf(group.at(-1) ?? group[0], targetDir);
            progress.done++;
            return ok(kept);
        }

        const queue = new PQueue({ concurrency: MATERIALIZE_WIDTH });
        const outcomes = await Promise.all([...byDest.values()].map((group) => queue.add(() => stageDest(group))));
        const uniqueStaged: StagedInput[] = [];
        for (const outcome of outcomes) {
            if (outcome === null) continue;
            if (outcome.isErr()) return err({ type: "staging_failed", cause: outcome.error });
            if (outcome.value !== null) uniqueStaged.push(outcome.value);
        }

        const reconcileResult = await reconcileStagedTree(targetDir, uniqueStaged);
        if (reconcileResult.isErr()) return err({ type: "staging_failed", cause: reconcileResult.error });

        return ok({ staged: uniqueStaged, warnings });
    } finally {
        progressByAnalysis.delete(analysisId);
    }
}

/** The manifest row of the staged copy at the destination of `file`, or `null` when no copy is there. */
async function keptCopyOf(file: InputFile, targetDir: string): Promise<StagedInput | null> {
    const stats = await stat(join(targetDir, file.relativePath)).then(
        (s) => s,
        () => null,
    );
    return stats?.isFile() === true ? stagedInputOf(file, stats) : null;
}

/** What the enumeration found: the paths staging would write, and the warnings about the sources it could not reach. */
export type InputEnumeration = {
    readonly paths: ReadonlySet<string>;
    readonly warnings: readonly string[];
    /** The count of inputs whose source is not reachable now. Such an input keeps its profile. */
    readonly unreachable: number;
};

/**
 * The read-only twin of {@link stageInputs}: the set of analysis-relative paths staging would produce for
 * `analysisId`, without linking, copying, or writing the session tree — which need not even exist. Both funnel
 * through {@link walkInputFiles}, so the two cannot disagree about which files an analysis has; the dedup by
 * `relativePath` mirrors staging's same-dest collision rule (last write wins) so the set equals the manifest's
 * paths exactly. `dataDir` is the staging target, from which an unreachable source's staged files are carried;
 * `null` carries none.
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
 *
 * @param analysisId - The analysis whose input paths to enumerate.
 * @returns The enumeration, or a `DbError` (input listing / anchor resolution).
 */
export function enumerateInputPaths(analysisId: string, dataDir: string | null): ResultAsync<InputEnumeration, DbError> {
    return walkInputFiles(analysisId, dataDir).map(async ({ files, warnings, unreachable }) => {
        const exists = await pathsExistAsync(
            files.map((file) => file.absPath),
            METADATA_WIDTH,
        );
        // Overlapping inputs can resolve to the same `relativePath`; staging keeps the LAST
        // such entry, and a Set on that key collapses them identically.
        const paths = new Set<string>();
        for (const [index, file] of files.entries()) {
            if (!exists[index]) {
                getLogger("staging").warn({ absPath: file.absPath }, "input file disappeared between the walk and its stat — treating it as removed");
                continue;
            }
            paths.add(file.relativePath);
        }
        return { paths, warnings, unreachable };
    });
}

/** How many directories {@link firstFileOf} reads before it gives up. */
const PROBE_SEARCH_DIRS = 64;

/** One regular file at or under `path`, found breadth first, or `null` when the bounded search finds none. */
async function firstFileOf(path: string): Promise<string | null> {
    const queue = [path];
    for (let read = 0; read < PROBE_SEARCH_DIRS; read++) {
        const dir = queue.shift();
        if (dir === undefined) return null;
        const stats = await stat(dir).then(
            (s) => s,
            () => null,
        );
        if (stats === null) continue;
        if (stats.isFile()) return dir;
        if (!stats.isDirectory()) continue;
        const entries = await readdir(dir, { withFileTypes: true }).then(
            (e) => e,
            () => [],
        );
        for (const entry of entries) {
            if (entry.isFile() && quarantineReason(entry.name) === undefined) return join(dir, entry.name);
            if ((entry.isDirectory() || entry.isSymbolicLink()) && !IGNORED_WALK_DIRS.has(entry.name)) queue.push(join(dir, entry.name));
        }
    }
    return null;
}

/** `path`, or its nearest ancestor that exists as a directory, or `null`. */
async function nearestExistingDir(path: string): Promise<string | null> {
    let current = path;
    for (;;) {
        const isDir = await stat(current).then(
            (s) => s.isDirectory(),
            () => false,
        );
        if (isDir) return current;
        const parent = dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

/**
 * Whether staging can hardlink the files of `sources` into `targetDir`, the analysis `data/` directory or the folder
 * that will hold it. For each volume of the sources, it makes one real hardlink of one file into the nearest existing
 * directory of `targetDir`, then removes it. A comparison of `st_dev` is not enough: exFAT refuses a hardlink on the
 * same device. Gives the warning for the sources that staging will copy, or `null` when each link worked or no
 * source has a file to try.
 */
export async function probeHardlinks(sources: readonly string[], targetDir: string): Promise<string | null> {
    const dir = await nearestExistingDir(targetDir);
    if (dir === null) return null;
    const probedDevices = new Map<number, boolean>();
    const copied: string[] = [];
    for (const source of sources) {
        const file = await firstFileOf(source);
        if (file === null) continue;
        const stats = await stat(file).then(
            (s) => s,
            () => null,
        );
        if (stats === null) continue;
        let linked = probedDevices.get(stats.dev);
        if (linked === undefined) {
            const probe = join(dir, `.inflexa-link-probe-${randomUUIDv7()}`);
            linked = await link(file, probe).then(
                () => true,
                () => false,
            );
            if (linked) await rm(probe, { force: true }).catch(() => undefined);
            probedDevices.set(stats.dev, linked);
        }
        if (!linked) copied.push(source);
    }
    if (copied.length === 0) return null;
    return (
        `Staging will copy ${copied.join(", ")} into the analysis, because a hardlink from there into the analysis folder failed. ` +
        `A copy takes time and disk space. To prevent the copy, put the analysis folder on the same volume as the data.`
    );
}

/**
 * The largest gap between two `mtimeMs` readings still treated as the same modification instant.
 *
 * The copy fallback stamps the source's mtime onto the destination with `utimesSync` ({@link stageFile}),
 * which takes an f64 seconds value: the sub-millisecond tail a nanosecond-granularity filesystem reports
 * (`…704.7327`) does not survive the ms → seconds → `timespec` → ms round-trip and reads back a few
 * float-ULPs short (`…704.732`). An exact `===` therefore reported ~90% of copy-staged files as drifted
 * on APFS (measured), re-staging genomics-sized inputs on every parity check for nothing. Measured drift
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
 * resolution — exactly as enumeration reports them. A source that the walk cannot read is not in the expected set.
 *
 * @param analysisId - The analysis whose current input set to check.
 * @param targetDir - The data directory root staging writes under (`workspaceDataDir(analysis)`).
 */
export function isInputSetMaterialized(analysisId: string, targetDir: string): ResultAsync<boolean, DbError> {
    return walkInputFiles(analysisId, targetDir).map(async ({ files }) => {
        // Overlapping inputs can resolve to one `relativePath`; staging keeps the LAST entry, so the
        // expected tree is that same collapse — comparing against the dropped entry's source would
        // report a mismatch for a path the manifest never claimed.
        const expected = new Map<string, InputFile>();
        for (const file of files) expected.set(file.relativePath, file);

        // One mismatch decides the answer, thus a pair that has not started stats nothing after it.
        let mismatch: boolean | undefined;
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
        const existing = await walkFiles(localRoot, WALK_EVERYTHING);
        if (existing.skipped.length > 0) return false;
        // Absolute-vs-absolute, the comparison `reconcileStagedTree` makes for the same reason: a
        // manifest key is not always a clean relative path, so only `join`ed absolutes agree.
        const expectedPaths = new Set([...expected.keys()].map((relativePath) => join(targetDir, relativePath)));
        for (const rel of existing.files) {
            if (!expectedPaths.has(join(localRoot, rel))) return false;
        }
        return true;
    });
}
