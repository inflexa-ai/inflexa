import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";

import { env } from "../../lib/env.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { closureOf, composeFarm, extendFarm, readDepsGraph, removeAnalysisFarm } from "./composition.ts";

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
const RPKGA = "rpkga-1.0-000000000000fff0";
const RPKGB = "rpkgb-2.1-000000000000fff1";

const created: string[] = [];

/**
 * A store root that holds the fixture pool, the graph, and a catalog template farm.
 *
 * The pool and the graph come from the checked-in fixture, because they are the
 * golden input. The template farm is derived from them, thus the test builds it
 * rather than checking in a tree of links whose targets resolve nowhere on the host.
 */
function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-farm-"));
    created.push(root);
    cpSync(FIXTURE, root, { recursive: true });

    const template = join(root, "farms", "catalog");
    mkdirSync(join(template, "python", "site-packages"), { recursive: true });
    for (const [name, storeDir] of [
        ["Rpkga", RPKGA],
        ["Rpkgb", RPKGB],
    ]) {
        mkdirSync(join(template, "r", "cran"), { recursive: true });
        symlinkSync(`${MOUNT}/store/${storeDir}/${name}`, join(template, "r", "cran", name as string));
    }
    for (const cache of ["numba-cache", "matplotlib_config"]) {
        mkdirSync(join(template, cache), { recursive: true });
        writeFileSync(join(template, cache, "warm.bin"), "warm\n");
    }
    writeFileSync(
        join(template, "lock.json"),
        `${JSON.stringify({ requested: ["beta", "gamma", "typing_ext"], resolved: ["beta==0.4.1", "gamma==3.0.0", "typing_ext==4.9.0"], store_dirs: [ALPHA, BETA, GAMMA, DELTA, TYPING] }, null, 2)}\n`,
    );
    writeFileSync(join(template, "meta.json"), `${JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python", "r"] }, null, 2)}\n`);
    return root;
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
});

// --- 1.1 The graph reader -----------------------------------------------------

describe("readDepsGraph", () => {
    test("indexes each node by its store-directory name, and it keeps the R inner directory", () => {
        const graph = readDepsGraph(tempStore())._unsafeUnwrap();

        expect(graph.version).toBe(1);
        expect(graph.nodes.size).toBe(11);
        expect(graph.nodes.get(BETA)).toEqual({ track: "python", imports: ["beta", "nsroot"], entryPoints: ["beta-run"], edges: [ALPHA], rDir: null });
        expect(graph.nodes.get(RPKGA)?.rDir).toBe("Rpkga");
        expect(graph.nodes.get(ALPHA)?.rDir).toBeNull();
    });

    test("refuses a graph with a dangling edge, and it names each one", () => {
        const root = tempStore();
        writeFileSync(join(root, "deps.json"), JSON.stringify({ version: 1, nodes: { a: { track: "python", edges: ["b", "c"] } } }));

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
        writeFileSync(join(root, "deps.json"), JSON.stringify({ version: 2, nodes: {} }));

        expect(readDepsGraph(root)._unsafeUnwrapErr().type).toBe("graph_unusable");
    });

    test("an absent graph is an io failure that names the read", () => {
        const root = tempStore();
        rmSync(join(root, "deps.json"));

        expect(readDepsGraph(root)._unsafeUnwrapErr().type).toBe("io_failed");
    });
});

// --- 1.2 The closure walk -----------------------------------------------------

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

// --- 1.3 to 1.5 The link pass, the markers, and the warm caches ---------------

describe("composeFarm", () => {
    test("links the closure of the template's requested set, with each of the three link shapes", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const farm = (await composeFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        expect(farm.farmPath).toBe(join(root, "farms", analysisId));
        // The requested set of the template is beta, gamma, and typing_ext. The walk
        // adds alpha and delta, and it leaves omega outside.
        expect([...farm.storeDirs].sort()).toEqual([ALPHA, BETA, DELTA, GAMMA, RPKGA, RPKGB, TYPING].sort());

        const tree = treeOf(farm.farmPath);
        // A top-level entry that ONE store directory gives stays a link into the pool.
        expect(tree.get("python/site-packages/beta")).toBe(`link:${MOUNT}/store/${BETA}/beta`);
        expect(tree.get("python/site-packages/alpha.libs")).toBe(`link:${MOUNT}/store/${ALPHA}/alpha.libs`);
        expect(tree.get("python/site-packages/typing_ext")).toBe(`link:${MOUNT}/store/${TYPING}/typing_ext`);
        // The record of the store is not content, thus the farm never links it.
        expect(tree.has("python/site-packages/.inflexa-pin")).toBe(false);

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

        await composeFarm({ storeRoot: root, analysisId });
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

    test("writes the two completeness markers that the usability gate requires, in the shared shape", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        await composeFarm({ storeRoot: root, analysisId });
        const farmPath = join(root, "farms", analysisId);

        const inventory = readFileSync(join(farmPath, "packages.txt"), "utf8");
        expect(inventory.startsWith("# Available packages in the sandbox environment.\n")).toBe(true);
        // The R triple comes before Python, which is the order of the shared producer.
        expect(inventory.indexOf("## R (CRAN)")).toBeLessThan(inventory.indexOf("## Python (pip)"));
        expect(inventory).toContain("Rpkga, Rpkgb");
        // The producer replaces an underscore with a hyphen in a distribution name.
        expect(inventory).toContain("alpha, beta, delta, gamma, typing-ext");
        expect(readFileSync(join(farmPath, "python.packages.txt"), "utf8")).toBe("## Python (pip)\nalpha, beta, delta, gamma, typing-ext\n");

        const meta = JSON.parse(readFileSync(join(farmPath, "meta.json"), "utf8")) as { version: string; arch: string; tracks: string[] };
        expect(meta).toEqual({ version: analysisId, arch: "linux-arm64", tracks: ["python", "r"] });

        const lock = JSON.parse(readFileSync(join(farmPath, "lock.json"), "utf8")) as { requested: string[]; store_dirs: string[] };
        expect(lock.requested).toEqual([BETA, GAMMA, RPKGA, RPKGB, TYPING].sort());
        expect(lock.store_dirs).toEqual([ALPHA, BETA, DELTA, GAMMA, RPKGA, RPKGB, TYPING].sort());
    });

    test("links the warm caches of the template, and it copies no cache file", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        await composeFarm({ storeRoot: root, analysisId });
        const tree = treeOf(join(root, "farms", analysisId));

        expect(tree.get("numba-cache")).toBe(`link:${MOUNT}/farms/catalog/numba-cache`);
        expect(tree.get("matplotlib_config")).toBe(`link:${MOUNT}/farms/catalog/matplotlib_config`);
        // A copy would put the cache file inside the farm.
        expect(tree.has("numba-cache/warm.bin")).toBe(false);
    });

    test("takes the roots that the caller names, and it leaves the rest of the pool alone", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const farm = (await composeFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        expect([...farm.storeDirs].sort()).toEqual([ALPHA, BETA]);
        expect(existsSync(join(farm.farmPath, "python", "site-packages", "gamma"))).toBe(false);
        expect(existsSync(join(farm.farmPath, "r"))).toBe(false);
    });

    test("an unknown root fails with the name of the root, and it makes no partial farm", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        const failed = (await composeFarm({ storeRoot: root, analysisId, roots: ["scanpy-1.0-0000000000000000"] }))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "unknown_root", roots: ["scanpy-1.0-0000000000000000"] });
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);
    });

    test("refuses when the store carries no catalog template", async () => {
        const root = tempStore();
        rmSync(join(root, "farms", "catalog"), { recursive: true });

        const failed = (await composeFarm({ storeRoot: root, analysisId: randomUUIDv7() }))._unsafeUnwrapErr();

        expect(failed.type).toBe("template_unusable");
    });
});

// --- 1.6 The per-farm mutex ---------------------------------------------------

describe("the per-farm mutex", () => {
    test("serializes two compositions of one farm, and the farm holds the links of both", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

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

        const [first, second] = await Promise.all([composeFarm({ storeRoot: root, analysisId: one }), composeFarm({ storeRoot: root, analysisId: two })]);

        expect(first._unsafeUnwrap().farmPath).toBe(join(root, "farms", one));
        expect(second._unsafeUnwrap().farmPath).toBe(join(root, "farms", two));
    });

    test("releases the lock file, thus a later composition of the same farm proceeds", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        (await composeFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect(existsSync(join(env.locksDir, `farm-${analysisId}.lock`))).toBe(false);
        expect((await extendFarm({ storeRoot: root, analysisId, roots: [BETA] })).isOk()).toBe(true);
    });
});

// --- 1.7 The version-collision refusal ----------------------------------------

describe("a version collision", () => {
    test("refuses with both store directories, and it leaves the farm as it was", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
        const before = treeOf(join(root, "farms", analysisId));

        const failed = (await extendFarm({ storeRoot: root, analysisId, roots: [ALPHA_2] }))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "version_collision", name: "alpha", existing: ALPHA, incoming: ALPHA_2 });
        expect(treeOf(join(root, "farms", analysisId))).toEqual(before);
    });

    test("a shared namespace directory is not a collision, because no side owns the import name", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

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
        (await composeFarm({ storeRoot: root, analysisId, roots: [SPECTRUM_LIKE] }))._unsafeUnwrap();

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

        const composed = await composeFarm({ storeRoot: root, analysisId, roots: [SPECTRUM_LIKE, AIRR_LIKE] });

        expect(composed.isOk()).toBe(true);
        expect(treeOf(join(root, "farms", analysisId)).get("python/site-packages/tests")).toBe("dir");
    });
});

// --- 1.8 and 1.9 The golden-fixture parity test -------------------------------

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
        "provision.build_farm(farm, [provision.STORE / n for n in spec['python']])",
        "stored = {sub: [(name, provision.STORE / d) for name, d in pairs] for sub, pairs in spec['r'].items()}",
        "provision.build_r_farm(farm, stored)",
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

        (await composeFarm({ storeRoot: root, analysisId, roots }))._unsafeUnwrap();
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

// --- 2.2 and 2.6 The extension path -------------------------------------------

describe("extendFarm", () => {
    test("adds the new closure and it touches no existing link, thus a live sandbox needs no restart", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
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
        (await composeFarm({ storeRoot: root, analysisId, roots: [BETA] }))._unsafeUnwrap();

        const extended = (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect([...extended.roots].sort()).toEqual([BETA, TYPING].sort());
        expect([...extended.storeDirs].sort()).toEqual([ALPHA, BETA, TYPING].sort());
    });

    test("re-derives the inventory, thus the new package is advertised", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId, roots: [ALPHA] }))._unsafeUnwrap();
        expect(readFileSync(join(root, "farms", analysisId, "packages.txt"), "utf8")).not.toContain("typing-ext");

        (await extendFarm({ storeRoot: root, analysisId, roots: [TYPING] }))._unsafeUnwrap();

        expect(readFileSync(join(root, "farms", analysisId, "packages.txt"), "utf8")).toContain("alpha, typing-ext");
    });
});

// --- 2.3 The removal ----------------------------------------------------------

describe("removeAnalysisFarm", () => {
    test("removes the farm and it leaves the pool untouched", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        const pool = readdirSync(join(root, "store")).sort();

        const removed = (await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        expect(removed).toEqual({ farmPath: join(root, "farms", analysisId), removed: true });
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);
        expect(readdirSync(join(root, "store")).sort()).toEqual(pool);
        expect(existsSync(join(root, "farms", "catalog"))).toBe(true);
    });

    test("a lease that names the farm blocks the removal, and the farm stays", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        mkdirSync(join(root, "leases"), { recursive: true });
        writeFileSync(join(root, "leases", "sbx-1"), `${JSON.stringify({ lease: "sbx-1", farm: analysisId })}\n`);
        writeFileSync(join(root, "leases", "sbx-2"), `${JSON.stringify({ lease: "sbx-2", farm: "someone-else" })}\n`);

        const failed = (await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrapErr();

        expect(failed).toEqual({ type: "farm_leased", analysisId, leases: ["sbx-1"] });
        expect(existsSync(join(root, "farms", analysisId))).toBe(true);
    });

    test("a lease that names no farm holds every farm, thus it blocks the removal too", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();
        (await composeFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        mkdirSync(join(root, "leases"), { recursive: true });
        writeFileSync(join(root, "leases", "sbx-old"), `${JSON.stringify({ lease: "sbx-old", farm: null })}\n`);

        expect((await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrapErr()).toEqual({
            type: "farm_leased",
            analysisId,
            leases: ["sbx-old"],
        });
    });

    test("an absent farm is a normal state, not an error", async () => {
        const root = tempStore();

        const removed = (await removeAnalysisFarm({ storeRoot: root, analysisId: randomUUIDv7() }))._unsafeUnwrap();

        expect(removed.removed).toBe(false);
    });
});

// --- 2.5 A chat-only analysis -------------------------------------------------

describe("composition is lazy", () => {
    test("a chat-only analysis makes no farm, because only a composition makes one", async () => {
        const root = tempStore();
        const analysisId = randomUUIDv7();

        // Everything that a chat-only analysis can reach: the graph reads, the closure
        // walks, and the deletion of the analysis removes a farm that was never made.
        const graph = readDepsGraph(root)._unsafeUnwrap();
        closureOf(graph, [BETA])._unsafeUnwrap();
        (await removeAnalysisFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();

        expect(readdirSync(join(root, "farms"))).toEqual(["catalog"]);
        expect(existsSync(join(root, "farms", analysisId))).toBe(false);

        // The first sandbox action of the analysis is what makes the farm.
        (await composeFarm({ storeRoot: root, analysisId }))._unsafeUnwrap();
        expect(readdirSync(join(root, "farms")).sort()).toEqual(["catalog", analysisId].sort());
    });
});
