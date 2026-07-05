/**
 * The on-disk library store: a versioned directory tree under `libStorePath`
 * with a single mutable `current` symlink naming the active version. The whole
 * parent is bind-mounted read-only at `/mnt/libs`, so `current -> <version>`
 * resolves *inside* the container (design.md "The on-disk store").
 *
 * ```
 *  <libStorePath>/
 *  ├── current -> <version>            the ONE mutable pointer
 *  ├── <version>/                      immutable once activated
 *  │   ├── r/{cran,bioconductor,github}/   (amd64 stores only)
 *  │   ├── python/  node/node_modules/  conda/bin/
 *  │   ├── packages.txt                    advisory header + concat of the pulled tracks' fragments
 *  │   └── meta.json                       {version,arch,tracks}
 *  ├── .staging-<version>-<uuid>/      in-flight extract; renamed in on success
 *  └── .cache/blobs/<sha256>           content-addressed dedup substrate
 * ```
 *
 * The correctness spine is atomic activation: `current` only ever names a
 * complete, verified version or is absent — never a partial tree. Extraction
 * happens in a unique `.staging-<version>-<uuid>/`; a same-filesystem `rename()`
 * promotes it to `<version>/` atomically, then a temp-symlink `rename()` over
 * `current` flips the pointer with no window where `current` is missing. This is
 * the embedding downloader's `.part`→rename discipline (`embedding/setup.ts`)
 * lifted from one file to a whole tree.
 *
 * Concurrency is deliberately simple: `libsPull` holds the machine-wide instance
 * lock (`lib/lock.ts`, key `lib-store`) across every mutation here, so at most
 * one pull runs at a time. {@link prune} therefore treats every `.staging-*` /
 * `.current.tmp-*` entry and orphaned `.part` file it sees as crash debris and
 * sweeps it unconditionally — the only process that could own one is the caller
 * itself, whose staging was already consumed by {@link activate}.
 */

import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { ARCHES, TRACK_SUBTREE, type Arch, type Track } from "./arch.ts";

/** Store IO that failed unexpectedly (a genuine fault, never a routine "no store"). */
export type StoreError = { readonly type: "store_io_failed"; readonly message: string; readonly cause?: unknown };

/** Metadata written into each version dir so `status` can name the active version/arch. */
export type StoreMeta = {
    readonly version: string;
    readonly arch: Arch;
    readonly tracks: readonly Track[];
    /**
     * Per-track sha256 of each track's source tarball (the manifest digest). Ties store
     * identity to CONTENT, not just track NAMES, so {@link sameStoreContent} treats a
     * same-version republish with different bytes as a mismatch and replaces the stale
     * tree. Optional: a meta lacking it (pre-digest or foreign) makes identity unprovable,
     * which {@link sameStoreContent} also counts as a mismatch.
     */
    readonly trackDigests?: Readonly<Record<string, string>>;
};

/** The resolved active store: the version `current` points at, plus its metadata (if readable). */
export type ActiveStore = {
    readonly version: string;
    readonly versionDir: string;
    /** `null` when `meta.json` is absent/unreadable (a store from before this field existed). */
    readonly meta: StoreMeta | null;
};

/** Absolute path of the `current` symlink under a store root. */
export function currentLink(root: string): string {
    return join(root, "current");
}

/**
 * Defense-in-depth for the path-segment builders below: assert `path` resolves
 * to a location CONTAINED under `root`. A published `version` is already validated
 * as a safe path segment by the manifest zod schema ({@link safeVersion} in
 * manifest.ts), so a traversal here means that gate was bypassed (a hand-built
 * store, a future caller that skips the schema, or a code change). Fail loud — an
 * invariant assertion, not a runtime error channel — rather than let a
 * `join(root, "../../x")` escape and have `activate`/`prune` rename or delete an
 * arbitrary directory. No legitimate call path can trip it once the schema validates.
 */
function assertUnderRoot(root: string, path: string): void {
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || rel.startsWith(`..${"\\"}`) || isAbsolute(rel)) {
        throw new Error(`Refusing a store path that escapes the store root (${root}): ${path}`);
    }
}

/** Absolute path of a version directory. */
export function versionDir(root: string, version: string): string {
    const dir = join(root, version);
    assertUnderRoot(root, dir);
    return dir;
}

/**
 * Mint a unique staging directory path for a version (`.staging-<version>-<uuid>`).
 * Uniqueness means a crashed pull's leftover staging can never collide with — and
 * pollute — a fresh pull's extract; {@link prune} sweeps the leftovers. Does not
 * create the dir — the caller `mkdir`s it.
 */
export function newStagingDir(root: string, version: string): string {
    const dir = join(root, `.staging-${version}-${randomUUIDv7()}`);
    assertUnderRoot(root, dir);
    return dir;
}

// Dedup mechanism A (a content-addressed blob cache) is chosen for v1:
// predictable, fs-agnostic, and it matches the manifest's content-addressing.
// TODO(extend): mechanism B (reflink/hardlink unchanged subtrees between
// versions) trades disk for re-download; revisit only if disk pressure bites.
// TODO(extend): blob GC — `prune` reclaims whole versions but never the blob
// cache; a `--reclaim` that drops blobs no live version references is a later add.
/** The content-addressed dedup cache directory. */
export function cacheDir(root: string): string {
    return join(root, ".cache", "blobs");
}

/** Absolute path of a cached blob, keyed by its sha256 digest. */
export function blobPath(root: string, sha256: string): string {
    return join(cacheDir(root), sha256);
}

/** True when the dedup cache already holds a blob with this digest (the "already held" check). */
export function hasBlob(root: string, sha256: string): boolean {
    return existsSync(blobPath(root, sha256));
}

async function wrap<T>(op: () => Promise<T>, message: string): Promise<Result<T, StoreError>> {
    try {
        return ok(await op());
    } catch (cause) {
        return err({ type: "store_io_failed", message: `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, cause });
    }
}

/**
 * Resolve `current` → the active store. Returns `ok(null)` when no store is
 * installed (a missing `current` is a normal, expected state — a degraded, not
 * broken, machine), reserving the error channel for a genuine IO fault.
 */
export async function readActive(root: string): Promise<Result<ActiveStore | null, StoreError>> {
    let target: string;
    try {
        target = await readlink(currentLink(root));
    } catch (cause) {
        // ENOENT / EINVAL (missing link or not-a-symlink) is "no store", not a fault.
        if (cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "EINVAL")) return ok(null);
        return err({
            type: "store_io_failed",
            message: `Failed to read the current-store pointer: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
        });
    }

    const version = basename(target);
    // A degenerate pointer (`current -> .` / `..` / an empty target) is not a store and
    // not a fault: heal to "no store" rather than letting versionDir's containment
    // assertion throw on this never-hard-fail read path.
    if (version === "" || version === "." || version === "..") return ok(null);
    const vdir = versionDir(root, version);
    if (!existsSync(vdir)) return ok(null); // dangling pointer heals to "no store"

    // Missing/corrupt meta.json degrades to null — status still shows the version.
    return ok({ version, versionDir: vdir, meta: await readMeta(vdir) });
}

/** Read and shape-check a directory's `meta.json`; `null` when absent or corrupt. */
async function readMeta(dir: string): Promise<StoreMeta | null> {
    try {
        const raw: unknown = JSON.parse(await Bun.file(join(dir, "meta.json")).text()); // unknown: on-disk JSON, shape-checked below
        return isStoreMeta(raw) ? raw : null;
    } catch {
        return null;
    }
}

/**
 * Structural guard for the on-disk `meta.json` (external data — validated before
 * trust). `arch` and every `tracks` entry are checked against the KNOWN value
 * sets, not merely `typeof`: a foreign/edited meta naming `arch:"solaris"` or
 * `tracks:["banana"]` must fail the guard so it degrades to `meta: null` rather
 * than reaching `libsStatus`, where `TRACK_SUBTREE[unknownTrack]` would be
 * `undefined` and crash the never-hard-fail status command.
 */
function isStoreMeta(v: unknown): v is StoreMeta {
    if (typeof v !== "object" || v === null) return false;
    const o = v as Record<string, unknown>; // narrowed field-by-field below
    return (
        typeof o.version === "string" &&
        typeof o.arch === "string" &&
        (ARCHES as readonly string[]).includes(o.arch) &&
        Array.isArray(o.tracks) &&
        // Object.hasOwn, NOT `t in TRACK_SUBTREE`: `in` walks the prototype chain, so a
        // foreign meta naming tracks:["toString"] would pass, then TRACK_SUBTREE["toString"]
        // is a function that libsStatus joins and throws on — the never-hard-fail status crash.
        o.tracks.every((t): t is Track => typeof t === "string" && Object.hasOwn(TRACK_SUBTREE, t)) &&
        // Optional: absent (pre-digest meta) is valid; present must be a string→string map
        // so sameStoreContent never compares a non-string digest.
        (o.trackDigests === undefined || isStringRecord(o.trackDigests))
    );
}

/** A plain object whose every own value is a string (rejects arrays and non-string values). */
function isStringRecord(v: unknown): v is Record<string, string> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

/** Write the version metadata into a staging dir before activation (so it is never observed partial). */
export async function writeMeta(staging: string, meta: StoreMeta): Promise<Result<void, StoreError>> {
    return wrap(async () => {
        await writeFile(join(staging, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    }, "Failed to write store metadata");
}

/**
 * Promote a fully-assembled staging dir to its version and flip `current` onto
 * it — the atomic activation. The staging→version `rename` is atomic on a shared
 * filesystem; the pointer swap renames a temp symlink over `current`, atomic on
 * POSIX with no window where `current` is absent. Idempotent: if the version dir
 * already exists with IDENTICAL content (same arch + per-track digests — a re-pull
 * of the same version), the staging dir is discarded and only the pointer is
 * (re)affirmed. When content differs (a republish at an unchanged version, or a rebuild
 * that adds tracks), the existing tree is replaced — keeping it would re-point `current`
 * at stale content.
 */
export async function activate(root: string, version: string, staging: string): Promise<Result<void, StoreError>> {
    // Guard BEFORE any promotion: never activate a staging tree whose own meta.json is
    // unreadable. A null staged meta means this is not the verified store we assembled —
    // extraction never finished. Without this guard the replace branch below would read
    // the null meta as "mismatch", rename the GOOD existing version out of the way, and
    // flip `current` onto an incomplete tree. Fail on the Result channel rather than
    // corrupting the active store.
    const stagedMeta = await readMeta(staging);
    if (stagedMeta === null) {
        return err({
            type: "store_io_failed",
            message: `Refusing to activate ${version}: the staged meta.json is missing or unreadable (staging incomplete).`,
        });
    }

    return wrap(async () => {
        const vdir = versionDir(root, version);

        if (!existsSync(vdir)) {
            await rename(staging, vdir);
        } else if (await sameStoreContent(stagedMeta, vdir)) {
            // Immutable version already present with identical content; the freshly-extracted staging is redundant.
            await rm(staging, { recursive: true, force: true });
        } else {
            // Replace via two renames rather than an in-place rm: `current` then never
            // observes a partially-deleted tree — between the renames the pointer briefly
            // dangles, which readActive heals to "no store" (degraded, never partial).
            const doomed = join(root, `.replaced-${randomUUIDv7()}`);
            await rename(vdir, doomed);
            try {
                await rename(staging, vdir);
            } catch (cause) {
                // Second rename failed (ENOSPC/EIO/…): the old working store is parked in
                // `doomed`. Roll it back so `current` never dangles and the good tree is
                // never orphaned — a working store must survive a mid-activate failure.
                // If even the rollback fails, prune keeps `.replaced-*` while `current`
                // dangles, preserving the lifeboat.
                await rename(doomed, vdir).catch(() => {});
                throw cause;
            }
            await rm(doomed, { recursive: true, force: true });
        }

        // Heal a `current` that is a real directory (or plain file) rather than a
        // symlink — the shape a symlink-DEREFERENCING restore leaves behind (`cp -rL`,
        // `rsync` without `-l`). `rename(tmp, current)` fails EISDIR against a real dir,
        // so without this every pull would brick on the pointer swap AFTER the multi-GB
        // download. Move the impostor aside as a `.replaced-*` lifeboat so the swap
        // proceeds. A genuine symlink is left untouched for `rename` to replace
        // atomically (no window where `current` is absent).
        const cur = currentLink(root);
        const curStat = await lstat(cur).catch(() => null);
        if (curStat !== null && !curStat.isSymbolicLink()) {
            await rename(cur, join(root, `.replaced-${randomUUIDv7()}`));
        }

        // Atomic pointer swap: create the new link off to the side, then rename it
        // over `current`. A relative target keeps the link valid inside the container.
        const tmp = join(root, `.current.tmp-${randomUUIDv7()}`);
        await symlink(version, tmp);
        await rename(tmp, cur);
    }, "Failed to activate the store version");
}

/**
 * Whether an existing version dir carries the same CONTENT the staged meta describes,
 * by arch + per-track sha256 — NOT just track names (matching names alone would let a
 * same-version republish with different bytes be judged "same", discarding the verified
 * staging for the stale tree). When either side lacks digests (unreadable or pre-digest
 * meta) identity is unprovable → mismatch, so the verified staging wins. The staged side
 * is non-null per {@link activate}'s pre-promotion guard.
 */
async function sameStoreContent(staged: StoreMeta, vdir: string): Promise<boolean> {
    const existing = await readMeta(vdir);
    if (existing === null) return false;
    if (staged.arch !== existing.arch) return false;
    const a = staged.trackDigests;
    const b = existing.trackDigests;
    if (a === undefined || b === undefined) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((k) => a[k] === b[k]);
}

/** Discard a staging dir (best-effort cleanup of a failed/cancelled pull, or the no-op after a successful activate consumed it). */
export async function discardStaging(staging: string): Promise<void> {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
}

/**
 * Keep the newest `keepN` versions the CLI pulled; delete older ones. The version
 * `current` points at is NEVER removed, even if it falls outside the newest `keepN`
 * (an old-but-active version stays mounted).
 *
 * Candidates are ONLY dirs carrying a valid, CLI-written `meta.json` — foreign
 * trees (e.g. `scripts/build-libs-local.sh`'s `local-<ts>` builds, which write no
 * `meta.json` into this shared store dir) are never counted toward `keepN` and
 * never deleted; among CLI versions the date prefix (`2026.07.04-<hash>`) makes a
 * lexical sort chronological.
 *
 * Also sweeps crash debris. The caller holds the machine-wide pull lock (see the
 * module doc), so nothing else can be mid-pull: every `.staging-*` /
 * `.current.tmp-*` entry and orphaned `.part` file is a crashed pull's leftover,
 * reclaimed unconditionally. `.replaced-*` (a tree parked by {@link activate}) is
 * the one exception: while `current` dangles it may be the ONLY surviving copy of
 * a working store after a mid-activate failure, so it is swept only when the
 * store is healthy.
 */
export async function prune(root: string, keepN: number): Promise<Result<void, StoreError>> {
    // Resolve the active store FIRST and fail CLOSED on a hard fault: without a
    // trustworthy `current` read we cannot guarantee the live version is excluded from
    // deletion, so skip reclamation entirely (a leaked old version is harmless; deleting
    // the active one is catastrophic). A missing store (ok(null)) prunes normally.
    const activeResult = await readActive(root);
    if (activeResult.isErr()) return err(activeResult.error);
    const activeVersion = activeResult.value?.version;
    const storeHealthy = activeVersion !== undefined;

    return wrap(async () => {
        const entries = await readdir(root, { withFileTypes: true });

        for (const e of entries) {
            const p = join(root, e.name);
            if (e.name.startsWith(".staging-") || e.name.startsWith(".current.tmp-")) {
                await rm(p, { recursive: true, force: true });
            } else if (e.name.startsWith(".replaced-") && storeHealthy) {
                await rm(p, { recursive: true, force: true });
            }
        }
        await reapParts(cacheDir(root));

        // Only CLI-owned versions (valid meta.json) are prune candidates.
        const candidates: string[] = [];
        for (const e of entries) {
            if (!(e.isDirectory() || e.isSymbolicLink())) continue;
            if (e.name.startsWith(".") || e.name === "current") continue;
            if ((await readMeta(versionDir(root, e.name))) !== null) candidates.push(e.name);
        }
        const versions = candidates.sort().reverse(); // date-prefixed → newest first

        // Retain at most keepN versions, ALWAYS including the active one. A `--pin` at a
        // version older than the keepN newest must occupy a slot, not sit ON TOP of them
        // (else keepN+1 accumulate). A foreign active (no meta.json) isn't a candidate here.
        const keep = new Set<string>();
        if (activeVersion !== undefined && versions.includes(activeVersion)) keep.add(activeVersion);
        for (const v of versions) {
            if (keep.size >= keepN) break;
            keep.add(v);
        }
        for (const v of versions) {
            // `keep` already holds any candidate active version; this guards the live tree anyway.
            if (v === activeVersion || keep.has(v)) continue;
            await rm(versionDir(root, v), { recursive: true, force: true });
        }
    }, "Failed to prune old store versions");
}

/** Sweep orphaned `.part` download sidecars (crash debris — a live one cannot exist under the pull lock). Best-effort. */
async function reapParts(cache: string): Promise<void> {
    let names: string[];
    try {
        names = await readdir(cache);
    } catch {
        return; // no cache dir yet
    }
    for (const name of names) {
        if (name.endsWith(".part")) await rm(join(cache, name), { force: true }).catch(() => {});
    }
}

/** Ensure the store root and dedup cache exist. */
export async function ensureStoreDirs(root: string): Promise<Result<void, StoreError>> {
    return wrap(async () => {
        await mkdir(cacheDir(root), { recursive: true });
    }, "Failed to create store directories");
}
