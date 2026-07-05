import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";

import { TRACK_SUBTREE, type Track } from "./arch.ts";
import {
    activate,
    blobPath,
    cacheDir,
    currentLink,
    discardStaging,
    ensureStoreDirs,
    hasBlob,
    newStagingDir,
    prune,
    readActive,
    versionDir,
    writeMeta,
    type StoreMeta,
} from "./store.ts";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "libstore-"));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const FULL: Track[] = ["python", "conda", "node", "cran", "bioconductor", "github"];
const CORE: Track[] = ["python", "conda", "node"];

/** Build a plausible per-process-unique staging version (subtrees + packages.txt + meta) and return its path. */
async function stageVersion(version: string, tracks: readonly Track[] = CORE): Promise<string> {
    const staging = newStagingDir(root, version);
    for (const track of tracks) {
        await mkdir(join(staging, TRACK_SUBTREE[track]), { recursive: true });
    }
    const hasR = tracks.includes("cran");
    await writeFile(join(staging, "packages.txt"), hasR ? "python:numpy\npython:pandas\nr:cran:dplyr\n" : "python:numpy\npython:pandas\n");
    const meta: StoreMeta = { version, arch: "linux-amd64", tracks: [...tracks] };
    (await writeMeta(staging, meta))._unsafeUnwrap();
    return staging;
}

/** Names of `.replaced-*` dirs currently under the root. */
async function replacedDirs(): Promise<string[]> {
    return (await readdir(root)).filter((n) => n.startsWith(".replaced-"));
}

describe("atomic activation", () => {
    test("activate promotes staging and points current at a complete version", async () => {
        const staging = await stageVersion("2026.07.04-aaa");
        (await activate(root, "2026.07.04-aaa", staging))._unsafeUnwrap();

        expect(await Bun.file(join(versionDir(root, "2026.07.04-aaa"), "packages.txt")).exists()).toBe(true);
        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(active?.meta?.tracks).toEqual(CORE);
        // staging is consumed by the rename
        expect(existsSync(staging)).toBe(false);
    });

    test("a mid-pull reader sees the prior version, never the staging tree", async () => {
        const first = await stageVersion("2026.07.04-aaa");
        (await activate(root, "2026.07.04-aaa", first))._unsafeUnwrap();

        // A second pull is in flight: its staging dir exists but is not activated.
        await stageVersion("2026.07.05-bbb");

        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa"); // still the old, complete version
        expect(active?.version).not.toContain(".staging");
    });

    test("an interrupted (never-activated) pull leaves current unchanged and is discardable", async () => {
        const first = await stageVersion("2026.07.04-aaa");
        (await activate(root, "2026.07.04-aaa", first))._unsafeUnwrap();

        const staging = await stageVersion("2026.07.05-bbb");
        await discardStaging(staging); // pull failed before activation

        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(existsSync(staging)).toBe(false);
    });

    test("re-activating an existing version is idempotent (staging discarded)", async () => {
        const first = await stageVersion("2026.07.04-aaa");
        (await activate(root, "2026.07.04-aaa", first))._unsafeUnwrap();

        const again = await stageVersion("2026.07.04-aaa"); // same version staged again
        (await activate(root, "2026.07.04-aaa", again))._unsafeUnwrap();

        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(existsSync(again)).toBe(false);
    });

    test("re-activating the same version with a DIFFERENT track set replaces the stale tree", async () => {
        const coreStaging = await stageVersion("2026.07.04-aaa", CORE);
        (await activate(root, "2026.07.04-aaa", coreStaging))._unsafeUnwrap();

        // A wider track set at the SAME published version (e.g. a local rebuild that adds the
        // R triple): the staging tree carries R subtrees the existing version dir lacks, so
        // activate must replace the stale tree rather than keep it.
        const fullStaging = await stageVersion("2026.07.04-aaa", FULL);
        (await activate(root, "2026.07.04-aaa", fullStaging))._unsafeUnwrap();

        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(active?.meta?.tracks).toEqual(FULL);
        expect(existsSync(join(versionDir(root, "2026.07.04-aaa"), TRACK_SUBTREE.cran))).toBe(true);
        expect(await Bun.file(join(versionDir(root, "2026.07.04-aaa"), "packages.txt")).text()).toContain("r:cran:dplyr");
        expect(existsSync(fullStaging)).toBe(false);
        // A clean replace leaves no `.replaced-*` orphan (created, renamed onto, rm'd).
        expect(await replacedDirs()).toEqual([]);
    });

    test("the activated version tree carries no dotfile debris (bind-mounted into sandboxes)", async () => {
        const staging = await stageVersion("2026.07.04-aaa");
        (await activate(root, "2026.07.04-aaa", staging))._unsafeUnwrap();
        expect((await readdir(versionDir(root, "2026.07.04-aaa"))).filter((n) => n.startsWith("."))).toEqual([]);
    });

    test("activate heals a `current` that is a real directory rather than a symlink (finding 3)", async () => {
        // A symlink-DEREFERENCING restore (cp -rL, rsync without -l) leaves `current` as a
        // REAL directory; rename(tmp, current) would fail EISDIR on every pull otherwise.
        await mkdir(currentLink(root), { recursive: true });
        await writeFile(join(currentLink(root), "stale.txt"), "deref-restore debris\n");

        (await activate(root, "2026.07.04-aaa", await stageVersion("2026.07.04-aaa")))._unsafeUnwrap();

        // `current` is now a proper symlink at the new version, and readActive resolves it.
        expect((await lstat(currentLink(root))).isSymbolicLink()).toBe(true);
        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        // The displaced real dir was parked as a `.replaced-*` lifeboat, not left in place.
        expect((await replacedDirs()).length).toBe(1);
    });

    test("readActive returns null when no store is installed", async () => {
        expect((await readActive(root))._unsafeUnwrap()).toBeNull();
        expect(existsSync(currentLink(root))).toBe(false);
    });

    test("readActive heals a degenerate `current -> ..` pointer to no-store, never throwing (finding 1 never-hard-fail)", async () => {
        // A hand-crafted pointer whose basename is `..` must NOT trip versionDir's
        // containment assertion on this read path — it heals to "no store".
        await symlink("..", currentLink(root));
        expect((await readActive(root))._unsafeUnwrap()).toBeNull();
    });

    test("activate refuses to promote a staging tree whose meta.json is unreadable", async () => {
        // A staging tree with subtrees + packages.txt but NO meta.json (extraction never
        // finished): activate must NOT promote it.
        const version = "2026.07.04-nometa";
        const staging = newStagingDir(root, version);
        await mkdir(join(staging, TRACK_SUBTREE.python), { recursive: true });
        await writeFile(join(staging, "packages.txt"), "python:numpy\n");

        expect((await activate(root, version, staging)).isErr()).toBe(true);
        expect((await readActive(root))._unsafeUnwrap()).toBeNull(); // current never created
        expect(existsSync(versionDir(root, version))).toBe(false); // nothing promoted
    });

    test("activate with an unreadable staged meta does NOT replace the good existing version (data-loss guard)", async () => {
        const coreStaging = await stageVersion("2026.07.04-aaa", CORE);
        (await activate(root, "2026.07.04-aaa", coreStaging))._unsafeUnwrap();

        // A re-staged SAME version whose meta.json is gone: the replace branch must not
        // fire — the good tree stays active.
        const staging = newStagingDir(root, "2026.07.04-aaa");
        await mkdir(join(staging, TRACK_SUBTREE.python), { recursive: true });
        await writeFile(join(staging, "packages.txt"), "python:numpy\n");

        expect((await activate(root, "2026.07.04-aaa", staging)).isErr()).toBe(true);
        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(active?.meta?.tracks).toEqual(CORE); // untouched, still the verified core tree
    });

    // finding 4: a promote-rename failure mid-replace must roll back so the old working
    // store survives. EXDEV (a staging dir on a different filesystem than the store root)
    // is the deterministic stand-in for ENOSPC/EIO during `rename(staging → version)`.
    test("activate rolls back and restores the old version when the promote rename fails (finding 4)", async () => {
        const seam = await crossDeviceStaging("2026.07.04-aaa", FULL);
        if (seam === null) return; // cross-device staging unavailable on this host — skip

        try {
            const coreStaging = await stageVersion("2026.07.04-aaa", CORE);
            (await activate(root, "2026.07.04-aaa", coreStaging))._unsafeUnwrap();

            // The cross-device staging carries a DIFFERENT track set (the R triple), so activate
            // takes the replace branch: rename(vdir → .replaced-*) succeeds, rename(staging → vdir)
            // fails with EXDEV → rollback restores vdir.
            const res = await activate(root, "2026.07.04-aaa", seam.staging);
            expect(res.isErr()).toBe(true);

            const active = (await readActive(root))._unsafeUnwrap();
            expect(active?.version).toBe("2026.07.04-aaa"); // current never dangled
            expect(active?.meta?.tracks).toEqual(CORE); // OLD working store restored intact
            expect(existsSync(join(versionDir(root, "2026.07.04-aaa"), TRACK_SUBTREE.cran))).toBe(false);
            // Rollback renamed the parked tree back — no reapable `.replaced-*` lifeboat is left dangling.
            expect(await replacedDirs()).toEqual([]);
        } finally {
            await seam.cleanup();
        }
    });
});

describe("dedup cache", () => {
    test("hasBlob reflects a content-addressed blob's presence", async () => {
        (await ensureStoreDirs(root))._unsafeUnwrap();
        const sha = "a".repeat(64);
        expect(hasBlob(root, sha)).toBe(false);
        await mkdir(cacheDir(root), { recursive: true });
        await writeFile(blobPath(root, sha), "tarball-bytes");
        expect(hasBlob(root, sha)).toBe(true);
    });
});

describe("prune", () => {
    test("keeps the newest N versions and never deletes the active one", async () => {
        for (const v of ["2026.01.01-a", "2026.02.02-b", "2026.03.03-c", "2026.04.04-d"]) {
            (await activate(root, v, await stageVersion(v)))._unsafeUnwrap();
        }
        // Point current back at an OLD version (outside the newest 2).
        (await activate(root, "2026.02.02-b", await stageVersion("2026.02.02-b")))._unsafeUnwrap();

        (await prune(root, 2))._unsafeUnwrap();

        // newest 2 (c, d) kept; active b kept despite being older; oldest a pruned.
        expect(existsSync(versionDir(root, "2026.04.04-d"))).toBe(true);
        expect(existsSync(versionDir(root, "2026.03.03-c"))).toBe(true);
        expect(existsSync(versionDir(root, "2026.02.02-b"))).toBe(true);
        expect(existsSync(versionDir(root, "2026.01.01-a"))).toBe(false);
    });

    test("sweeps a leftover staging dir — under the pull lock any leftover is crash debris", async () => {
        (await activate(root, "2026.01.01-a", await stageVersion("2026.01.01-a")))._unsafeUnwrap();

        const orphan = newStagingDir(root, "2026.02.02-crashed");
        await mkdir(orphan, { recursive: true });
        await writeFile(join(orphan, "partial.bin"), "half-extracted");

        (await prune(root, 2))._unsafeUnwrap();

        expect(existsSync(orphan)).toBe(false); // swept
        expect(existsSync(versionDir(root, "2026.01.01-a"))).toBe(true); // active untouched
    });

    test("keeps a .replaced-* lifeboat while current dangles, sweeps it once the store is healthy (finding 4)", async () => {
        // Simulate a crash mid-activate: the old working store is parked in `.replaced-*`
        // and `current` dangles (points at a version dir that no longer exists).
        const replaced = join(root, `.replaced-${randomUUIDv7()}`);
        await mkdir(replaced, { recursive: true });
        await writeFile(join(replaced, "packages.txt"), "the-only-surviving-store\n");
        await symlink("2026.09.09-gone", currentLink(root));

        (await prune(root, 2))._unsafeUnwrap();
        expect(existsSync(replaced)).toBe(true); // NEVER deleted while current dangles — it is the only copy

        // Heal the store and prune again: the lifeboat is now redundant → swept.
        (await activate(root, "2026.01.01-a", await stageVersion("2026.01.01-a")))._unsafeUnwrap();
        (await prune(root, 2))._unsafeUnwrap();
        expect(existsSync(replaced)).toBe(false);
    });

    test("never prunes a foreign local-* build (no cli meta.json), even though it sorts newest", async () => {
        for (const v of ["2026.01.01-a", "2026.02.02-b", "2026.03.03-c"]) {
            (await activate(root, v, await stageVersion(v)))._unsafeUnwrap();
        }
        // `scripts/build-libs-local.sh` writes `local-<ts>` builds (no meta.json) into this
        // same dir; `local-*` sorts lexically AFTER the date-prefixed CI versions. It must be
        // ignored: never counted toward keepN, never deleted.
        const local = versionDir(root, "local-20260704-120000");
        await mkdir(local, { recursive: true });
        await writeFile(join(local, "packages.txt"), "python:local\n");

        (await prune(root, 2))._unsafeUnwrap();

        expect(existsSync(local)).toBe(true); // foreign dir untouched
        // The local dir did NOT crowd out a real rollback: newest 2 CI versions kept, oldest pruned.
        expect(existsSync(versionDir(root, "2026.03.03-c"))).toBe(true);
        expect(existsSync(versionDir(root, "2026.02.02-b"))).toBe(true);
        expect(existsSync(versionDir(root, "2026.01.01-a"))).toBe(false);
    });

    test("sweeps an orphaned .current.tmp-* pointer-swap symlink (finding 12)", async () => {
        (await activate(root, "2026.01.01-a", await stageVersion("2026.01.01-a")))._unsafeUnwrap();

        // A crash BETWEEN symlink() and rename() in activate's pointer swap leaks a tmp
        // symlink that nothing else reaps.
        const tmp = join(root, `.current.tmp-${randomUUIDv7()}`);
        await symlink("2026.01.01-a", tmp);

        (await prune(root, 2))._unsafeUnwrap();

        const tmpExists = await lstat(tmp).then(
            () => true,
            () => false,
        );
        expect(tmpExists).toBe(false); // pointer-swap orphan swept
        expect(existsSync(versionDir(root, "2026.01.01-a"))).toBe(true); // active untouched
    });

    test("sweeps orphaned .part download sidecars, never completed blobs", async () => {
        (await ensureStoreDirs(root))._unsafeUnwrap();
        const orphan = join(cacheDir(root), `${"a".repeat(64)}.part`);
        await writeFile(orphan, "partial");
        await writeFile(blobPath(root, "b".repeat(64)), "a completed, verified blob");

        (await prune(root, 2))._unsafeUnwrap();

        expect(existsSync(orphan)).toBe(false); // crashed-download sidecar swept
        expect(hasBlob(root, "b".repeat(64))).toBe(true); // completed blob untouched
    });

    test("fails closed when the active-version read faults, never risking the live version", async () => {
        // Force a HARD readlink fault: a store root whose parent component is a FILE makes
        // readlink(<root>/current) throw ENOTDIR — not the benign ENOENT/EINVAL that means
        // "no store". prune must return Err and skip reclamation, not treat activeVersion as
        // undefined and delete it.
        const blocker = join(root, "blocker");
        await writeFile(blocker, "not a directory");
        expect((await prune(join(blocker, "store"), 2)).isErr()).toBe(true);
    });
});

describe("foreign meta.json degrades, never crashes", () => {
    test("a meta.json naming an unknown track resolves to meta:null (not a throw)", async () => {
        (await activate(root, "2026.07.04-aaa", await stageVersion("2026.07.04-aaa")))._unsafeUnwrap();

        // A hand-edited / restored-from-another-machine meta naming a track we don't know.
        await writeFile(
            join(versionDir(root, "2026.07.04-aaa"), "meta.json"),
            JSON.stringify({ version: "2026.07.04-aaa", arch: "linux-amd64", tracks: ["banana"] }),
        );

        // The tightened guard rejects it → graceful meta:null (status still shows the
        // version), never a TRACK_SUBTREE["banana"] === undefined crash downstream.
        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.version).toBe("2026.07.04-aaa");
        expect(active?.meta).toBeNull();
    });

    test("a meta.json whose tracks name a prototype key (toString) degrades to meta:null", async () => {
        (await activate(root, "2026.07.06-ccc", await stageVersion("2026.07.06-ccc")))._unsafeUnwrap();
        // "toString" lives on Object.prototype; a naive `t in TRACK_SUBTREE` would ACCEPT it,
        // then TRACK_SUBTREE["toString"] is a function that libsStatus joins and throws on.
        await writeFile(
            join(versionDir(root, "2026.07.06-ccc"), "meta.json"),
            JSON.stringify({ version: "2026.07.06-ccc", arch: "linux-amd64", tracks: ["toString"] }),
        );
        expect((await readActive(root))._unsafeUnwrap()?.meta).toBeNull();
    });

    test("a meta.json with an unknown arch also resolves to meta:null", async () => {
        (await activate(root, "2026.07.05-bbb", await stageVersion("2026.07.05-bbb")))._unsafeUnwrap();
        await writeFile(
            join(versionDir(root, "2026.07.05-bbb"), "meta.json"),
            JSON.stringify({ version: "2026.07.05-bbb", arch: "solaris", tracks: ["python"] }),
        );

        expect((await readActive(root))._unsafeUnwrap()?.meta).toBeNull();
    });

    test("a meta.json with extra unknown fields still reads back as valid (extra fields ignored)", async () => {
        (await activate(root, "2026.07.08-ddd", await stageVersion("2026.07.08-ddd")))._unsafeUnwrap();
        // isStoreMeta guards only version/arch/tracks; a foreign/legacy `bundle` (and any other
        // extra key) is ignored rather than rejected, so the store still resolves its meta.
        await writeFile(
            join(versionDir(root, "2026.07.08-ddd"), "meta.json"),
            JSON.stringify({ version: "2026.07.08-ddd", arch: "linux-amd64", tracks: ["python", "conda", "node"], bundle: "legacy", extra: 1 }),
        );
        const active = (await readActive(root))._unsafeUnwrap();
        expect(active?.meta?.version).toBe("2026.07.08-ddd");
        expect(active?.meta?.tracks).toEqual(["python", "conda", "node"]);
    });
});

// SECURITY (finding 1, layer 2): even if a traversal version slipped past the manifest
// schema, the path builders must refuse to hand back a path that escapes the store root.
describe("path builders refuse to escape the store root", () => {
    test.each(["../escape", "../../etc", "..", "a/../../b"])("versionDir throws for traversal version %p", (version) => {
        expect(() => versionDir(root, version)).toThrow();
    });

    // newStagingDir's `.staging-` prefix defuses a single `../`, so a genuine escape needs
    // enough `../` to climb past both the prefix dir and the root — the assertion catches it.
    test.each(["../../../../escape", "../../../../../etc"])("newStagingDir throws for traversal version %p", (version) => {
        expect(() => newStagingDir(root, version)).toThrow();
    });

    test("a normal version stays under the root", () => {
        expect(versionDir(root, "2026.07.04-abc")).toBe(join(root, "2026.07.04-abc"));
        expect(newStagingDir(root, "2026.07.04-abc").startsWith(join(root, ".staging-2026.07.04-abc-"))).toBe(true);
    });
});

/**
 * Build a valid staging tree on a DIFFERENT filesystem (`/dev/shm`) so promoting it
 * into the store root fails with EXDEV — the deterministic stand-in for a mid-activate
 * `rename()` failure (ENOSPC/EIO). Returns null when a genuinely cross-device staging
 * cannot be arranged (non-Linux, no `/dev/shm`, or same underlying device).
 */
async function crossDeviceStaging(version: string, tracks: readonly Track[]): Promise<{ staging: string; cleanup: () => Promise<void> } | null> {
    let base: string;
    try {
        await mkdir("/dev/shm", { recursive: true });
        base = await mkdtemp("/dev/shm/libstore-xdev-");
    } catch {
        return null;
    }
    const cleanup = async (): Promise<void> => {
        await rm(base, { recursive: true, force: true }).catch(() => {});
    };
    try {
        if ((await stat(base)).dev === (await stat(root)).dev) {
            await cleanup();
            return null; // same device — a rename would NOT be cross-device
        }
    } catch {
        await cleanup();
        return null;
    }
    const staging = join(base, `.staging-${version}`);
    for (const track of tracks) await mkdir(join(staging, TRACK_SUBTREE[track]), { recursive: true });
    await writeFile(join(staging, "packages.txt"), "python:numpy\nr:cran:dplyr\n");
    (await writeMeta(staging, { version, arch: "linux-amd64", tracks: [...tracks] }))._unsafeUnwrap();
    return { staging, cleanup };
}
