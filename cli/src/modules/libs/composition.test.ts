import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";

import { env } from "../../lib/env.ts";
import { instanceLockPath, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { closureOf, extendFarm, makeEmptyFarm, readDepsGraph, removeAnalysisFarm, resolveAnalysisFarm, resolvePackageRequest } from "./composition.ts";

// The golden fixture pool, checked in beside this file. It is the ONE input that
// both builders compose, thus a change to it changes both sides of the parity test.
const FIXTURE = join(import.meta.dir, "test-fixtures", "farm-parity");

// The provisioner that owns the other implementation of the farm layout.
const PROVISIONER = join(import.meta.dir, "..", "..", "..", "..", "images", "sandbox-provisioner");

/** The path the sandbox mounts the store root at. A farm link bakes an absolute target beneath it. */
const MOUNT = "/mnt/libs";

const ALPHA = "alpha-1.2.0-000000000000aaaa";
const ALPHA_2 = "alpha-2.0.0-00000000000a2222";
const BETA = "beta-0.4.1-000000000000bbbb";
const GAMMA = "gamma-3.0.0-000000000000cccc";
/** Two distributions that each ship a top-level `tests` package, as the real catalog does. */
const SPECTRUM_LIKE = "spectrum-like-0.5.0-00000000000ab001";
const AIRR_LIKE = "airr-like-2.0.0-00000000000ab002";
const DELTA = "delta-0.9-000000000000dddd";
const TYPING = "typing-ext-4.9.0-00000000000eeeee";
const OMEGA = "omega-9.9-0000000000009999";
/** In the catalog and in the graph, with NO edge pointing at it — the shape an extra gives. */
const EXTRADEP = "extradep-1.0.0-00000000000ex001";
const RPKGA = "rpkga-1.0-000000000000fff0";
const RPKGB = "rpkgb-2.1-000000000000fff1";

/** The lock architecture of the host, as an empty farm records it. */
const HOST_ARCH = process.arch === "arm64" ? "arm64" : "amd64";

const created: string[] = [];

/** One catalog lock entry, in the shape the provisioner writes. The test hashes are stable stand-ins. */
function catalogEntry(storeDir: string, track: string, requested: boolean): Record<string, unknown> {
    const stem = storeDir.slice(0, storeDir.lastIndexOf("-"));
    const name = stem.slice(0, stem.lastIndexOf("-"));
    const version = stem.slice(stem.lastIndexOf("-") + 1);
    return { name, version, track, store_dir: storeDir, hash: "f".repeat(64), requested };
}

/**
 * A store root that holds the fixture pool, the graph, and the catalog farm.
 *
 * The pool and the graph come from the checked-in fixture, because they are the
 * golden input. The catalog farm is derived from them: its `inflexa.lock` is the
 * record an extension reads (the R subtrees, the architecture, the languages),
 * and its prepared cache directories are what a new farm's cache seeds from.
 */
function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-farm-"));
    created.push(root);
    cpSync(FIXTURE, root, { recursive: true });

    const catalog = join(root, "farms", "catalog");
    mkdirSync(join(catalog, "python", "site-packages"), { recursive: true });
    for (const [name, storeDir] of [
        ["Rpkga", RPKGA],
        ["Rpkgb", RPKGB],
    ]) {
        mkdirSync(join(catalog, "r", "cran"), { recursive: true });
        symlinkSync(`${MOUNT}/store/${storeDir}/${name}`, join(catalog, "r", "cran", name as string));
    }
    for (const cache of ["numba-cache", "matplotlib_config"]) {
        mkdirSync(join(catalog, cache), { recursive: true });
        writeFileSync(join(catalog, cache, "warm.bin"), "warm\n");
    }
    const lock = {
        schema: 1,
        arch: "arm64",
        packages: [
            catalogEntry(ALPHA, "python", false),
            catalogEntry(BETA, "python", true),
            catalogEntry(DELTA, "python", false),
            catalogEntry(EXTRADEP, "python", false),
            catalogEntry(GAMMA, "python", true),
            catalogEntry(TYPING, "python", true),
            catalogEntry(RPKGA, "cran", true),
            catalogEntry(RPKGB, "cran", false),
        ],
        languages: {
            python: { version: "3.12", index: "https://pypi.org/simple" },
            r: { version: "4.6.0", bioc_releases: [] },
        },
    };
    writeFileSync(join(catalog, "inflexa.lock"), `${JSON.stringify(lock, null, 2)}\n`);
    return root;
}

/** The parsed `inflexa.lock` of one farm, read raw so a test asserts on the exact shape the gate reads. */
function farmLockOf(farmPath: string): {
    schema: number;
    arch: string;
    packages: { name: string; version: string; track: string; store_dir: string; hash: string; requested: boolean }[];
    languages: Record<string, unknown>;
    merge_conflicts?: { entry: string; action: string }[];
} {
    return JSON.parse(readFileSync(join(farmPath, "inflexa.lock"), "utf8"));
}

/** Every path of a tree, with what it holds: a directory, a file, or a link and its target. */
function treeOf(root: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string, prefix: string): void => {
        for (const entry of readdirSync(dir).sort()) {
            const path = join(dir, entry);
            const key = prefix === "" ? entry : `${prefix}/${entry}`;
            const stat = lstatSync(path);
            if (stat.isSymbolicLink()) out.set(key, `link:${readlinkSync(path)}`);
            else if (stat.isDirectory()) {
                out.set(key, "dir");
                walk(path, key);
            } else out.set(key, "file");
        }
    };
    walk(root, "");
    return out;
}

/** The identity of each link of a tree: its target and its inode. A changed inode proves that a pass rewrote the link. */
function linkIdentities(root: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, held] of treeOf(root)) {
        if (!held.startsWith("link:")) continue;
        out.set(path, `${held}#${lstatSync(join(root, path), { throwIfNoEntry: false })?.ino ?? "gone"}`);
    }
    return out;
}

/** The host path of a baked link target, which is how a link resolves once the store is mounted. */
function resolvesOnHost(storeRoot: string, target: string): boolean {
    return existsSync(target.startsWith(`${MOUNT}/`) ? join(storeRoot, target.slice(MOUNT.length + 1)) : target);
}

beforeEach(() => {
    // The per-farm mutex writes under `env.locksDir`, thus the sandbox guard must pass
    // before any test runs. Refer to `test_support/sandbox.ts`.
    assertTestSandbox(env.locksDir);
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    // A test of the reclamation wait seeds the reclaim lock. A record that outlived its test would make
    // each later composition of the suite yield until its wait ran out.
    rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
});

// --- The graph reader -----------------------------------------------------------

describe("readDepsGraph", () => {
    test("indexes each node by its store-directory name, and it keeps the R inner directory", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(graph.version).toBe(1);
        expect(graph.nodes.size).toBe(12);
        expect(graph.nodes.get(BETA)).toEqual({
            track: "python",
            name: "beta",
            version: "0.4.1",
            imports: ["beta", "nsroot"],
            entryPoints: ["beta-run"],
            edges: [ALPHA],
            rDir: null,
        });
        expect(graph.nodes.get(RPKGA)?.rDir).toBe("Rpkga");
        expect(graph.nodes.get(ALPHA)?.rDir).toBeNull();
    });

    test("keeps the version ordering of the emitter, one pool for each track, newest first", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        // The emitter settles the order, thus the reader keeps the list as it arrived.
        expect(graph.byName.python.get("alpha")).toEqual([ALPHA_2, ALPHA]);
        expect(graph.byName.python.get("typing-ext")).toEqual([TYPING]);
        expect(graph.byName.r.get("rpkga")).toEqual([RPKGA]);
        expect(graph.byName.python.has("rpkga")).toBe(false);
    });

    test("refuses a graph that carries no version ordering", () => {
        const root = tempStore();
        writeFileSync(join(root, "deps.json"), JSON.stringify({ version: 1, nodes: {} }));

        expect(readDepsGraph(root)._unsafeUnwrapErr().type).toBe("graph_unusable");
    });

    test("refuses a graph with a dangling edge, and it names each one", () => {
        const root = tempStore();
        writeFileSync(
            join(root, "deps.json"),
            JSON.stringify({
                version: 1,
                nodes: { a: { track: "python", name: "a", version: "1", edges: ["b", "c"] } },
                by_name: { python: {}, r: {} },
            }),
        );

        expect(readDepsGraph(root)._unsafeUnwrapErr()).toEqual({
            type: "graph_dangling_edge",
            edges: [
                { from: "a", to: "b" },
                { from: "a", to: "c" },
            ],
        });
    });

    test("refuses a graph of a version that it does not understand", () => {
        const root = tempStore();
        writeFileSync(join(root, "deps.json"), JSON.stringify({ version: 2, nodes: {}, by_name: { python: {}, r: {} } }));

        expect(readDepsGraph(root)._unsafeUnwrapErr().type).toBe("graph_unusable");
    });

    test("an absent graph is an io failure that names the read", () => {
        const root = tempStore();
        rmSync(join(root, "deps.json"));

        expect(readDepsGraph(root)._unsafeUnwrapErr().type).toBe("io_failed");
    });
});

// --- The closure walk -----------------------------------------------------------

describe("closureOf", () => {
    test("gives each node that the roots reach, and nothing outside the closure", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        const closure = closureOf(graph, [BETA, GAMMA])._unsafeUnwrap();

        expect([...closure].sort()).toEqual([ALPHA, BETA, DELTA, GAMMA].sort());
        expect(closure.has(OMEGA)).toBe(false);
    });

    test("names each root that the graph does not hold, and it opens no network call", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(closureOf(graph, ["scanpy-9.9-0000000000000000", BETA, "zzz"])._unsafeUnwrapErr()).toEqual({
            type: "unknown_root",
            roots: ["scanpy-9.9-0000000000000000", "zzz"],
        });
    });
});

// --- The request resolution -------------------------------------------------------

describe("resolvePackageRequest", () => {
    test("takes the head of the ordering when a request names no version", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        // The pool holds two versions of alpha. The emitter ordered them, thus the head
        // is the newest and the host compares nothing.
        expect(resolvePackageRequest(graph, { name: "alpha" })._unsafeUnwrap()).toEqual({
            storeDir: ALPHA_2,
            name: "alpha",
            version: "2.0.0",
            track: "python",
        });
    });

    test("takes the name in any spelling, because PEP 503 gives one canonical form", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "Typing_Ext" })._unsafeUnwrap().storeDir).toBe(TYPING);
    });

    test("resolves an exact version", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "alpha", version: "1.2.0" })._unsafeUnwrap()).toEqual({
            storeDir: ALPHA,
            name: "alpha",
            version: "1.2.0",
            track: "python",
        });
    });

    test("refuses a version that the pool lacks, and it names the versions that the pool holds", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "alpha", version: "3.0.0" })._unsafeUnwrapErr()).toEqual({
            type: "unknown_version",
            name: "alpha",
            version: "3.0.0",
            available: ["2.0.0", "1.2.0"],
        });
    });

    test("refuses a name that no track of the pool holds", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "scanpy" })._unsafeUnwrapErr()).toEqual({
            type: "unknown_distribution",
            name: "scanpy",
        });
    });

    test("searches the R track too, thus an R package reaches the same path", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "Rpkga" })._unsafeUnwrap()).toEqual({
            storeDir: RPKGA,
            name: "rpkga",
            version: "1.0",
            track: "r",
        });
    });

    test("a name that both tracks hold stops with the two candidates, and no silent pick exists", () => {
        // The fixture pool holds no both-hit name, so the graph of this test is its
        // own: one distribution named `igraph` in each track, which is the real shape
        // (PyPI and CRAN both serve igraph).
        const root = mkdtempSync(join(tmpdir(), "inflexa-bothhit-"));
        created.push(root);
        writeFileSync(
            join(root, "deps.json"),
            JSON.stringify({
                version: 1,
                nodes: {
                    "igraph-0.11-00000000000000py": { track: "python", name: "igraph", version: "0.11" },
                    "igraph-2.0-000000000000000r": { track: "r", name: "igraph", version: "2.0", r_dir: "igraph" },
                },
                by_name: { python: { igraph: ["igraph-0.11-00000000000000py"] }, r: { igraph: ["igraph-2.0-000000000000000r"] } },
            }),
        );
        const graph = readDepsGraph(root)._unsafeUnwrap();

        expect(resolvePackageRequest(graph, { name: "igraph" })._unsafeUnwrapErr()).toEqual({
            type: "ambiguous_ecosystem",
            name: "igraph",
            candidates: ["igraph-0.11-00000000000000py", "igraph-2.0-000000000000000r"],
        });
        // The qualifier is what settles it, in either direction.
        expect(resolvePackageRequest(graph, { name: "igraph", ecosystem: "python" })._unsafeUnwrap().storeDir).toBe("igraph-0.11-00000000000000py");
        expect(resolvePackageRequest(graph, { name: "igraph", ecosystem: "r" })._unsafeUnwrap().storeDir).toBe("igraph-2.0-000000000000000r");
    });
});

// --- The link pass, the lock, and the cache seed ---------------------------------

describe("extendFarm builds a farm from named roots", () => {
    test("links the closure of the named roots, with each of the three link shapes", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const farm = (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA, BETA, GAMMA, RPKGA, TYPING] }))._unsafeUnwrap();

        expect(farm.farmPath).toBe(join(root, "farms", analysisId));
        // The closure adds delta (gamma names it) and rpkgb (rpkga names it). It adds
        // nothing else: omega and extradep sit outside, because no named root reaches
        // either one.
        expect([...farm.storeDirs].sort()).toEqual([ALPHA, BETA, DELTA, GAMMA, RPKGA, RPKGB, TYPING].sort());
        expect(farm.storeDirs).not.toContain(OMEGA);
        expect(farm.storeDirs).not.toContain(EXTRADEP);

        const tree = treeOf(farm.farmPath);
        // A top-level entry that ONE store directory gives stays a link into the pool.
        expect(tree.get("python/site-packages/beta")).toBe(`link:${MOUNT}/store/${BETA}/beta`);
        expect(tree.get("python/site-packages/alpha.libs")).toBe(`link:${MOUNT}/store/${ALPHA}/alpha.libs`);
        expect(tree.get("python/site-packages/typing_ext")).toBe(`link:${MOUNT}/store/${TYPING}/typing_ext`);
        // The records of the store are not content, thus the farm never links them.
        expect(tree.has("python/site-packages/.inflexa-pin")).toBe(false);
        expect(tree.has("python/site-packages/.inflexa-hash")).toBe(false);

        // The R link names the INNER directory of the store directory.
        expect(tree.get("r/cran/Rpkga")).toBe(`link:${MOUNT}/store/${RPKGA}/Rpkga`);
        expect(tree.get("r/cran/Rpkgb")).toBe(`link:${MOUNT}/store/${RPKGB}/Rpkgb`);

        // The hoisted console script is RELATIVE, thus the farm can move.
        expect(tree.get("python/bin/alpha-cli")).toBe("link:../site-packages/bin/alpha-cli");
        expect(tree.get("python/bin/beta-run")).toBe("link:../site-packages/bin/beta-run");
    });

    test("promotes a shared namespace directory, at each depth, and links both sides beneath it", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        await extendFarm({ storeRoot: root, analysisId, roots: [BETA, GAMMA] });
        const tree = treeOf(join(root, "farms", analysisId));

        // beta, gamma, and delta each give a part of `nsroot`, thus it is a real directory.
        expect(tree.get("python/site-packages/nsroot")).toBe("dir");
        expect(tree.get("python/site-packages/nsroot/beta_plugin")).toBe(`link:${MOUNT}/store/${BETA}/nsroot/beta_plugin`);
        expect(tree.get("python/site-packages/nsroot/gamma_plugin")).toBe(`link:${MOUNT}/store/${GAMMA}/nsroot/gamma_plugin`);
        // gamma and delta both give `nsroot/shared`, thus the promotion recurses.
        expect(tree.get("python/site-packages/nsroot/shared")).toBe("dir");
        expect(tree.get("python/site-packages/nsroot/shared/gamma_leaf")).toBe(`link:${MOUNT}/store/${GAMMA}/nsroot/shared/gamma_leaf`);
        expect(tree.get("python/site-packages/nsroot/shared/delta_leaf")).toBe(`link:${MOUNT}/store/${DELTA}/nsroot/shared/delta_leaf`);
        // The merged `bin` is a directory too, because two store directories give one.
        expect(tree.get("python/site-packages/bin")).toBe("dir");
    });

    test("writes the one `inflexa.lock`, in the shape the mount gate reads", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const roots = [ALPHA, BETA, GAMMA, RPKGA, TYPING];

        await extendFarm({ storeRoot: root, analysisId, roots });
        const farmPath = join(root, "farms", analysisId);

        // The lock is the ONE metadata file: no packages.txt, no meta.json, no lock.json.
        expect(existsSync(join(farmPath, "packages.txt"))).toBe(false);
        expect(existsSync(join(farmPath, "meta.json"))).toBe(false);
        expect(existsSync(join(farmPath, "lock.json"))).toBe(false);

        const lock = farmLockOf(farmPath);
        expect(lock.schema).toBe(1);
        // The architecture comes from the catalog lock, which is the store's own record.
        expect(lock.arch).toBe("arm64");
        expect(lock.packages.map((entry) => entry.store_dir).sort()).toEqual([ALPHA, BETA, DELTA, GAMMA, RPKGA, RPKGB, TYPING].sort());
        // `requested` marks the roots the caller named; the closure members stay transitive.
        expect(lock.packages.find((entry) => entry.store_dir === BETA)?.requested).toBe(true);
        expect(lock.packages.find((entry) => entry.store_dir === DELTA)?.requested).toBe(false);
        // The R entries carry their subtree as the track, from the catalog lock.
        expect(lock.packages.find((entry) => entry.store_dir === RPKGA)?.track).toBe("cran");
        expect(lock.packages.find((entry) => entry.store_dir === ALPHA)?.track).toBe("python");
        // Each entry carries the full store hash, read from the pool marker.
        for (const entry of lock.packages) expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
        // The languages copy from the catalog, for the tracks the farm carries.
        expect(Object.keys(lock.languages).sort()).toEqual(["python", "r"]);
    });

    test("seeds no cache on an extension — the seed belongs to the farm creation", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        await extendFarm({ storeRoot: root, analysisId, roots: [BETA] });
        const tree = treeOf(join(root, "farms", analysisId));

        // No link into the catalog caches: a shared writable cache would let one
        // analysis plant compiled code for another, and the extension owns links only.
        expect(tree.has("numba-cache")).toBe(false);
        expect(tree.has("matplotlib_config")).toBe(false);
    });

    // A composition invents no package set.
    test("links what the caller named and its closure, and it links nothing else", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const farm = (await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        // beta names alpha, and nothing else. The pool holds much more, and the catalog
        // links much more, but a named root asks for what it needs and never for an
        // environment.
        expect([...farm.storeDirs].sort()).toEqual([ALPHA, BETA]);
        expect(farm.storeDirs).not.toContain(EXTRADEP);
        expect(existsSync(join(farm.farmPath, "python", "site-packages", "gamma"))).toBe(false);
        expect(existsSync(join(farm.farmPath, "python", "site-packages", "extradep"))).toBe(false);
        expect(existsSync(join(farm.farmPath, "r"))).toBe(false);
    });

    test("an unknown root fails with the name of the root, and it makes no partial farm", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const failed = (await extendFarm({ storeRoot: root, analysisId, roots: ["scanpy-1.0-0000000000000000"] }))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "unknown_root", roots: ["scanpy-1.0-0000000000000000"] });
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);
    });

    test("refuses when the store carries no catalog farm", async () => {
        const root = tempStore();
        rmSync(join(root, "farms", "catalog"), { recursive: true });

        const failed = (await extendFarm({ storeRoot: root, analysisId: randomUUIDv7(), roots: [BETA] }))._unsafeUnwrapErr();

        expect(failed.type).toBe("template_unusable");
    });
});

// --- The farm of a new analysis ---------------------------------------------------

describe("makeEmptyFarm", () => {
    test("carries the lock and the seeded cache, and it links no package", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const farm = (await makeEmptyFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        expect(farm).toEqual({ farmPath: join(root, "farms", analysisId), roots: [], storeDirs: [], added: [], tracks: [] });
        expect(readdirSync(farm.farmPath).sort()).toEqual(["cache", "inflexa.lock"]);
        // The lock advertises an empty inventory, thus the mount gate accepts the farm
        // and a chat-only analysis mounts it.
        const lock = farmLockOf(farm.farmPath);
        expect(lock).toEqual({ schema: 1, arch: HOST_ARCH, packages: [], languages: {} });
        // The cache SEEDS as a copy, never a link: a loaded numba entry executes
        // machine code, and a shared writable home would cross two analyses.
        expect(treeOf(farm.farmPath).get("cache/numba-cache/warm.bin")).toBe("file");
        expect(treeOf(farm.farmPath).get("cache/matplotlib_config/warm.bin")).toBe("file");
    });

    test("makes the farm without the catalog, because an analysis can precede the download", async () => {
        const root = tempStore();
        rmSync(join(root, "farms", "catalog"), { recursive: true });
        const analysisId = randomUUIDv7();

        const farm = (await makeEmptyFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        // No catalog means no cache to seed, and the miss degrades in silence.
        expect(farmLockOf(farm.farmPath).arch).toBe(HOST_ARCH);
        expect(existsSync(join(farm.farmPath, "cache", "numba-cache"))).toBe(false);
    });

    test("an extension of the empty farm links what it names, and the lock then records that root", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        const extended = (await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        expect([...extended.roots]).toEqual([BETA]);
        expect([...extended.storeDirs].sort()).toEqual([ALPHA, BETA]);
        const lock = farmLockOf(join(root, "farms", analysisId));
        expect(lock.packages.filter((entry) => entry.requested).map((entry) => entry.store_dir)).toEqual([BETA]);
    });
});

// --- The farm resolver ------------------------------------------------------------

describe("resolveAnalysisFarm", () => {
    test("heals a missing farm as an empty one, and its location carries the cache", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const resolution = await resolveAnalysisFarm(root, analysisId);

        expect(resolution).toEqual({
            kind: "available",
            location: { farmPath: join(root, "farms", analysisId), cachePath: join(root, "farms", analysisId, "cache") },
        });
        expect(existsSync(join(root, "farms", analysisId, "inflexa.lock"))).toBe(true);
    });

    test("answers an existing farm with one stat, and it re-seeds a cache the user removed", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await makeEmptyFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        rmSync(join(root, "farms", analysisId, "cache"), { recursive: true, force: true });

        const resolution = await resolveAnalysisFarm(root, analysisId);

        expect(resolution.kind).toBe("available");
        expect(existsSync(join(root, "farms", analysisId, "cache"))).toBe(true);
    });
});

// --- The per-farm mutex -----------------------------------------------------------

describe("the per-farm mutex", () => {
    test("serializes two compositions of one farm, and the farm holds the links of both", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        const [first, second] = await Promise.all([
            extendFarm({ storeRoot: root, analysisId, roots: [BETA] }),
            extendFarm({ storeRoot: root, analysisId, roots: [GAMMA] }),
        ]);

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        const tree = treeOf(join(root, "farms", analysisId));
        expect(tree.get("python/site-packages/beta")).toBe(`link:${MOUNT}/store/${BETA}/beta`);
        expect(tree.get("python/site-packages/nsroot/gamma_plugin")).toBe(`link:${MOUNT}/store/${GAMMA}/nsroot/gamma_plugin`);
        expect(tree.get("python/site-packages/typing_ext")).toBe(`link:${MOUNT}/store/${TYPING}/typing_ext`);
    });

    test("two different farms compose at the same time", async () => {
        const root = tempStore();
        const one = randomUUIDv7();
        const two = randomUUIDv7();

        const [first, second] = await Promise.all([
            extendFarm({ storeRoot: root, analysisId: one, roots: [BETA] }),
            extendFarm({ storeRoot: root, analysisId: two, roots: [GAMMA] }),
        ]);

        expect(first._unsafeUnwrap().farmPath).toBe(join(root, "farms", one));
        expect(second._unsafeUnwrap().farmPath).toBe(join(root, "farms", two));
    });

    test("releases the lock file, thus a later composition of the same farm proceeds", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect(existsSync(join(env.locksDir, `farm-${analysisId}.lock`))).toBe(false);
        expect((await extendFarm({ storeRoot: root, analysisId, roots: [BETA] })).isOk()).toBe(true);
    });
});

// --- The reclamation wait ---------------------------------------------------------
//
// A composition walks the graph, thus it can name a store directory that no farm
// links yet. A reclamation between the walk and the link would free that directory,
// and the farm would then hold a link that resolves to nothing.

describe("the yield to a reclamation", () => {
    /** A live foreign holder of the reclaim lock, because our own pid takes that key re-entrantly and would block nothing. */
    function liveReclamation(): { readonly pid: number; readonly stop: () => Promise<void> } {
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(env.locksDir, { recursive: true });
        writeFileSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), String(holder.pid));
        return {
            pid: holder.pid,
            stop: async () => {
                holder.kill();
                await holder.exited; // awaited so the child is reaped and the pid probe reports it dead
                rmSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), { force: true });
            },
        };
    }

    test("a composition waits for a live reclamation, and it holds no farm key while it waits", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const reclamation = liveReclamation();

        const composing = extendFarm({ storeRoot: root, analysisId, roots: [BETA] }, { reclaimPollMs: 5 });
        await Promise.sleep(50);
        // The farm directory is made INSIDE the critical section, thus an absent farm proves that the
        // composition linked nothing.
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);
        // The waiter drops the per-farm key. A waiter that held it would wait for the reclamation, and
        // the reclamation would wait for that key, thus the two would deadlock.
        expect(existsSync(join(env.locksDir, `farm-${analysisId}.lock`))).toBe(false);

        await reclamation.stop();
        const composed = await composing;

        expect(composed._unsafeUnwrap().storeDirs).toContain(BETA);
        expect(treeOf(join(root, "farms", analysisId)).get("python/site-packages/beta")).toBe(`link:${MOUNT}/store/${BETA}/beta`);
    });

    test("an extension refuses with the pid of the reclamation when the wait runs out, and the farm stays as it was", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();
        const before = treeOf(join(root, "farms", analysisId));
        const reclamation = liveReclamation();

        try {
            const refused = await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }, { reclaimWaitMs: 20, reclaimPollMs: 5 });

            expect(refused._unsafeUnwrapErr()).toEqual({ type: "reclaim_in_flight", analysisId, holderPid: reclamation.pid });
            expect(treeOf(join(root, "farms", analysisId))).toEqual(before);
        } finally {
            await reclamation.stop();
        }
    });

    test("an empty farm takes no yield, because it links no store directory", async () => {
        // The hazard is a link into the pool, and this farm makes none. A yield here would hold the
        // creation of an analysis behind a reclamation for nothing.
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const reclamation = liveReclamation();

        try {
            const made = await makeEmptyFarm({ storeRoot: root, analysisId });

            expect(made._unsafeUnwrap().storeDirs).toEqual([]);
            expect(existsSync(join(root, "farms", analysisId, "inflexa.lock"))).toBe(true);
        } finally {
            await reclamation.stop();
        }
    });

    test("a record of a dead reclamation blocks nothing, because the liveness of the holder is the signal", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const reclamation = liveReclamation();
        await reclamation.stop();
        // The record alone, with no live process behind it.
        writeFileSync(instanceLockPath(PACKAGE_STORE_RECLAIM_LOCK_KEY), String(reclamation.pid));

        const composed = await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }, { reclaimWaitMs: 20, reclaimPollMs: 5 });

        expect(composed._unsafeUnwrap().storeDirs).toContain(BETA);
    });
});

// --- The version-collision refusal ------------------------------------------------

describe("a version collision", () => {
    test("refuses with both store directories, and it leaves the farm as it was", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
        const before = treeOf(join(root, "farms", analysisId));

        const failed = (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA_2] }))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "version_collision", name: "alpha", existing: ALPHA, incoming: ALPHA_2 });
        expect(treeOf(join(root, "farms", analysisId))).toEqual(before);
    });

    test("a shared namespace directory is not a collision, because no side owns the import name", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        const extended = await extendFarm({ storeRoot: root, analysisId, roots: [GAMMA] });

        expect(extended.isOk()).toBe(true);
        expect(treeOf(join(root, "farms", analysisId)).get("python/site-packages/nsroot")).toBe("dir");
    });

    test("two distributions that each ship a top-level `tests` package merge, because neither is a second version", async () => {
        // The published catalog holds this shape: `tests`, `benchmarks`, and `resources`
        // each arrive from two distributions, and each carries its own `__init__.py`. A
        // refusal here would refuse the default closure, thus no analysis could compose.
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [SPECTRUM_LIKE] }))._unsafeUnwrap();

        const extended = await extendFarm({ storeRoot: root, analysisId, roots: [AIRR_LIKE] });

        expect(extended.isOk()).toBe(true);
        const tree = treeOf(join(root, "farms", analysisId));
        expect(tree.get("python/site-packages/tests")).toBe("dir");
        expect(tree.get("python/site-packages/tests/test_speclike.py")).toBe(`link:${MOUNT}/store/${SPECTRUM_LIKE}/tests/test_speclike.py`);
        expect(tree.get("python/site-packages/tests/test_airrlike.py")).toBe(`link:${MOUNT}/store/${AIRR_LIKE}/tests/test_airrlike.py`);
    });

    test("one composition of both distributions merges the shared name in one pass", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const composed = await extendFarm({ storeRoot: root, analysisId, roots: [SPECTRUM_LIKE, AIRR_LIKE] });

        expect(composed.isOk()).toBe(true);
        expect(treeOf(join(root, "farms", analysisId)).get("python/site-packages/tests")).toBe("dir");
    });
});

// --- The golden-fixture parity test -----------------------------------------------

/**
 * Compose the fixture with the farm builder of the provisioner.
 *
 * The provisioner refuses to build a farm when the store root is not the sandbox
 * mount, because a link would then bake a path that the sandbox cannot resolve. The
 * driver sets the two to the fixture root, which is what the Python tests of the
 * provisioner do, thus the Python side bakes the fixture path where the composer
 * bakes the sandbox mount. The comparison normalizes the two prefixes.
 */
function composeWithProvisioner(root: string, farmName: string, python: readonly string[], r: Record<string, [string, string][]>): void {
    const driver = [
        "import json, sys",
        "from pathlib import Path",
        "sys.path.insert(0, sys.argv[1])",
        "import provision",
        "root = Path(sys.argv[2])",
        "provision.LIBS = root",
        "provision.STORE = root / 'store'",
        "provision.FARMS = root / 'farms'",
        "provision.SANDBOX_MOUNT = root",
        "spec = json.loads(sys.argv[3])",
        "farm = provision.FARMS / spec['farm']",
        "farm.mkdir(parents=True, exist_ok=True)",
        "provision.build_python_track(farm, [provision.STORE / n for n in spec['python']])",
        "stored = {sub: [(name, provision.STORE / d) for name, d in pairs] for sub, pairs in spec['r'].items()}",
        "provision.build_r_track(farm, stored)",
    ].join("\n");

    let outcome: { exitCode: number; stderr: string };
    try {
        const run = Bun.spawnSync(["python3", "-c", driver, PROVISIONER, root, JSON.stringify({ farm: farmName, python, r })]);
        outcome = { exitCode: run.exitCode, stderr: run.stderr.toString() };
    } catch (cause) {
        // Never skip. A missing interpreter is a broken environment, and a parity test
        // that quietly passes without the other implementation pins nothing.
        throw new Error("the farm parity test needs python3 on PATH to run the provisioner farm builder, and it could not start one", { cause });
    }
    if (outcome.exitCode !== 0) {
        throw new Error(`python3 could not build the provisioner farm (exit ${outcome.exitCode}):\n${outcome.stderr}`);
    }
}

/** The `python` and `r` subtrees of a farm, with every link target reduced to one prefix. */
function comparableTracks(root: string, farmPath: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [path, held] of treeOf(farmPath)) {
        if (!path.startsWith("python/") && !path.startsWith("r/") && path !== "python" && path !== "r") continue;
        out.set(path, held.replace(`link:${MOUNT}/`, "link:@/").replace(`link:${root}/`, "link:@/"));
    }
    return out;
}

describe("the composed layout stays in parity with the provisioner layout", () => {
    test("one fixture pool, two builders, the same tree", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const roots = [ALPHA, BETA, DELTA, GAMMA, RPKGA, RPKGB, TYPING];

        (await extendFarm({ storeRoot: root, analysisId, roots }))._unsafeUnwrap();
        composeWithProvisioner(root, "provisioner", [ALPHA, BETA, DELTA, GAMMA, TYPING], {
            cran: [
                ["Rpkga", RPKGA],
                ["Rpkgb", RPKGB],
            ],
        });

        const composed = comparableTracks(root, join(root, "farms", analysisId));
        const provisioned = comparableTracks(root, join(root, "farms", "provisioner"));

        // A divergence must name the paths, thus the assertion compares the two maps
        // whole and never one entry at a time.
        expect(Object.fromEntries([...composed].sort())).toEqual(Object.fromEntries([...provisioned].sort()));
        expect(composed.size).toBeGreaterThan(10);
    });
});

// --- The extension path -----------------------------------------------------------

describe("extendFarm", () => {
    test("adds the new closure and it touches no existing link, thus a live sandbox needs no restart", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
        const farmPath = join(root, "farms", analysisId);
        const before = linkIdentities(farmPath);
        expect(before.size).toBeGreaterThan(0);

        const extended = (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        // Every link that the live sandbox already resolved is the same link, down to
        // its inode. Thus every resolution that the sandbox made stays valid.
        const after = linkIdentities(farmPath);
        for (const [path, identity] of before) expect(after.get(path)).toBe(identity);

        // The new link is there, and it resolves once the store is mounted.
        const target = readlinkSync(join(farmPath, "python", "site-packages", "typing_ext"));
        expect(target).toBe(`${MOUNT}/store/${TYPING}/typing_ext`);
        expect(resolvesOnHost(root, target)).toBe(true);
        expect([...extended.storeDirs].sort()).toEqual([ALPHA, TYPING].sort());
    });

    test("keeps the roots of the earlier composition, thus the closure only grows", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        const extended = (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect([...extended.roots].sort()).toEqual([BETA, TYPING].sort());
        expect([...extended.storeDirs].sort()).toEqual([ALPHA, BETA, TYPING].sort());
    });

    test("writes the lock again, thus the new package is advertised", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
        expect(farmLockOf(join(root, "farms", analysisId)).packages.map((entry) => entry.name)).not.toContain("typing-ext");

        (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect(farmLockOf(join(root, "farms", analysisId)).packages.map((entry) => entry.name)).toContain("typing-ext");
    });
});

// --- The removal ------------------------------------------------------------------

describe("removeAnalysisFarm", () => {
    test("removes the farm and it leaves the pool untouched", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await extendFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();
        const pool = readdirSync(join(root, "store")).sort();

        const removed = (await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        expect(removed).toEqual({ farmPath: join(root, "farms", analysisId), removed: true });
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);
        expect(readdirSync(join(root, "store")).sort()).toEqual(pool);
        expect(existsSync(join(root, "farms", "catalog"))).toBe(true);
    });

    test("an absent farm is a normal state, not an error", async () => {
        const root = tempStore();

        const removed = (await removeAnalysisFarm({ storeRoot: root, analysisId: randomUUIDv7() }))._unsafeUnwrap();

        expect(removed.removed).toBe(false);
    });
});

// --- A chat-only analysis ---------------------------------------------------------

describe("a chat-only analysis", () => {
    test("keeps the empty farm that its creation made, and it costs the lock and the cache alone", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        const farm = (await makeEmptyFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        const before = treeOf(farm.farmPath);

        // Everything that a chat-only analysis can reach: the graph reads, and the
        // closure walks. Neither one touches the farm, because only a link pass does.
        const graph = readDepsGraph(root)._unsafeUnwrap();
        closureOf(graph, [BETA])._unsafeUnwrap();

        expect(readdirSync(join(root, "farms")).sort()).toEqual(["catalog", analysisId].sort());
        expect(treeOf(farm.farmPath)).toEqual(before);
        expect(farm.storeDirs).toEqual([]);

        // The deletion of the analysis takes the farm away again.
        (await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        expect(readdirSync(join(root, "farms"))).toEqual(["catalog"]);
    });
});
