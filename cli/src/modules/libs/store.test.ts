import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUIDv7 } from "bun";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok } from "neverthrow";

import { runtimes, stream, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { LIB_STORE_DOWNLOAD_LOCK_KEY, LIB_STORE_RECLAIM_LOCK_KEY, instanceLockPath, releaseInstanceLock } from "../../lib/lock.ts";
import { db } from "../../db/primary.ts";
import {
    claimLibStoreFlight,
    insertAnalysis,
    insertAnchor,
    recordLibStoreDownloadManifest,
    recordLibStoreDownloadProgress,
    settleLibStoreDownload,
    startLibStoreDownloadRun,
    subscribeLibStoreFlight,
} from "../../db/primary_mutation.ts";
import type { Analysis } from "../../types/analysis.ts";
import { asStr256 } from "../../lib/types.ts";
import { extendFarm, readDepsGraph } from "./composition.ts";
import { libStoreDownloadPaths } from "./store_download.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    inspectStore,
    provisionPackages,
    reclaimPreview,
    reclaimStore,
    removeFarm,
    extendFarmForFlight,
    removeStaleActiveFarmPointer,
    runStoreAdd,
    runStoreCancel,
    runStoreDownload,
    runStoreLink,
    runStoreLs,
    type ProvisionerInvocation,
    type ProvisionerRunner,
} from "./store.ts";
import { libStoreFlightKey, parseLibStoreFlightSpec, readLibStoreFlights, withLibStoreFlight } from "./store_flight.ts";

// Each test builds an isolated store under tmpdir, never env.libStoreDir, so nothing touches real data.
// The container is always a stub: no test starts a real engine.
const created: string[] = [];

function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-store-"));
    created.push(root);
    return root;
}

// A reclamation claims the machine-wide reclaim lock, which lives under env.locksDir. At the monorepo
// root that is the developer's REAL lock directory; refuse to run there rather than seed or delete a real
// lock file (data-loss guard — see test_support/sandbox.ts).
beforeEach(() => {
    assertTestSandbox(env.locksDir);
    rmSync(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY), { force: true });
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    releaseInstanceLock(LIB_STORE_RECLAIM_LOCK_KEY);
    rmSync(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY), { force: true });
    db()
        .map((conn) => conn.query("DELETE FROM lib_store_flights").run())
        ._unsafeUnwrap();
});

/** A fake provisioner runner that records each invocation and exercises the observer path with one line. */
function spyRunner(result: CaptureResult): { runner: ProvisionerRunner; calls: ProvisionerInvocation[] } {
    const calls: ProvisionerInvocation[] = [];
    const runner: ProvisionerRunner = async (invocation, onLine) => {
        calls.push(invocation);
        onLine("[provision] working");
        return ok(result);
    };
    return { runner, calls };
}

/** An image seam that records that it ran, standing in for the pull of an absent provisioner image. */
function spyEnsureImage(): { ensureImage: () => Promise<ReturnType<typeof ok<void, never>>>; calls: number } {
    const spy = {
        calls: 0,
        ensureImage: async () => {
            spy.calls += 1;
            return ok(undefined);
        },
    };
    return spy;
}

const SUCCESS: CaptureResult = { code: 0, stdout: "", stderr: "" };

/** Build a farm the harness would mount: a directory carrying both completeness markers. */
function makeFarm(root: string, name: string, tracks: readonly string[] = ["python"]): string {
    const dir = join(root, "farms", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "packages.txt"), "scanpy 1.9\n");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ version: name, arch: "linux-arm64", tracks }));
    return dir;
}

/**
 * Put one analysis in the database, with the anchor its foreign key wants.
 *
 * The listing names the analysis of each farm and of each flight subscriber, thus a real row is what
 * those two assertions read. The rows are removed after each test, so no test sees the analysis of
 * another.
 */
function seedAnalysis(name: string): Analysis {
    const now = Date.now();
    const anchorId = randomUUIDv7();
    insertAnchor({ id: anchorId, createdAt: now, updatedAt: now, cachedPath: join(tmpdir(), "anchor"), markerWritten: true, lastSeen: now })._unsafeUnwrap();
    const analysis: Analysis = {
        id: randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        name: asStr256(name),
        slug: name.toLowerCase().replace(/\W+/g, "-"),
        anchorId,
        projectId: null,
    };
    return insertAnalysis(analysis)._unsafeUnwrap();
}

/**
 * Give a store root the fixture pool, its graph, and a catalog template farm.
 *
 * Composition reads the template for the architecture of the store and for the warm caches, thus a root
 * with no template composes nothing. The pool itself is the golden fixture of the parity test.
 */
function seedComposablePool(root: string): void {
    cpSync(join(import.meta.dir, "test-fixtures", "farm-parity"), root, { recursive: true });
    const template = join(root, "farms", "catalog");
    mkdirSync(join(template, "python", "site-packages"), { recursive: true });
    writeFileSync(
        join(template, "lock.json"),
        JSON.stringify({ requested: ["beta"], resolved: ["beta==0.4.1"], store_dirs: ["alpha-1.2.0-000000000000aaaa", "beta-0.4.1-000000000000bbbb"] }),
    );
    writeFileSync(join(template, "meta.json"), JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python"] }));
}

describe("provisionPackages — the acquisition path", () => {
    test("passes the specs alone, with no farm argument and no removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages({ storeRoot: root, specs: ["scanpy"] }, { run: runner, ensureImage: async () => ok(undefined) });
        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(1);
        // The whole of task 4.2: acquisition names no farm, thus the container does no farm work.
        expect(calls[0]!.args).toEqual(["scanpy"]);
        expect(calls[0]!.args).not.toContain("--farm");
        expect(calls[0]!.network).toBe("online");
        expect(calls[0]!.image).toBe("ghcr.io/inflexa-ai/sandbox-provisioner:latest");
        for (const flag of ["--reclaim", "--remove-farm", "--repair"]) expect(calls[0]!.args).not.toContain(flag);
    });

    test("obtains the provisioner image before it starts the container, and never asks for a configured one", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const image = spyEnsureImage();
        const result = await provisionPackages({ storeRoot: root, specs: ["scanpy"] }, { run: runner, ensureImage: image.ensureImage });
        expect(result.isOk()).toBe(true);
        expect(image.calls).toBe(1);
        expect(calls).toHaveLength(1);
    });

    test("an image that cannot be obtained stops the command before the container starts", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, specs: ["scanpy"] },
            { run: runner, ensureImage: async () => err({ type: "image_unavailable" as const, message: "ghcr.io is unreachable" }) },
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("image_unavailable");
        expect(calls).toHaveLength(0);
    });

    test("maps a store-lock conflict to an actionable message", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] another provisioning run holds the store lock; retry when it finishes\n" });
        const result = await provisionPackages({ storeRoot: root, specs: ["scanpy"] }, { run: runner, ensureImage: async () => ok(undefined) });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("store_locked");
            expect(result.error.message.toLowerCase()).toContain("lock");
        }
    });

    test("surfaces any other non-zero exit as a provisioner failure", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] uv could not resolve nonexistent-pkg\n" });
        const result = await provisionPackages({ storeRoot: root, specs: ["nonexistent-pkg"] }, { run: runner, ensureImage: async () => ok(undefined) });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("provisioner_failed");
    });

    test("an observer that throws does not fail the run", async () => {
        const root = tempStore();
        const { runner } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, specs: ["scanpy"] },
            {
                run: runner,
                ensureImage: async () => ok(undefined),
                onProgress: () => {
                    throw new Error("observer boom");
                },
            },
        );
        expect(result.isOk()).toBe(true);
    });
});

// The migration of an installed store: the first store command removes the pointer of the old layout,
// and it leaves each farm exactly as it was (task 6.1, task 6.3).
describe("removeStaleActiveFarmPointer — the upgrade of an installed store", () => {
    test("an upgraded store loses the pointer one time, and its farms stay valid", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        makeFarm(root, "catalog");
        mkdirSync(join(root, "farms", "catalog", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/foo-1.0-aaa", join(root, "farms", "catalog", "python", "site-packages", "foo"));
        symlinkSync("farms/catalog", join(root, "current"));

        removeStaleActiveFarmPointer(root);
        expect(existsSync(join(root, "current"))).toBe(false);

        // Each farm survives with its links, because no farm link ever involved the pointer.
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.farms.map((farm) => farm.name)).toEqual(["catalog"]);
        expect(inspection.farms[0]!.links).toBe(1);
        expect(existsSync(join(root, "farms", "catalog", "python", "site-packages", "foo"))).toBe(true);
        expect(inspection.packages.map((pkg) => pkg.dir)).toEqual(["foo-1.0-aaa"]);

        // Idempotent: a second run changes nothing at all.
        const before = readdirSync(root).sort();
        removeStaleActiveFarmPointer(root);
        expect(readdirSync(root).sort()).toEqual(before);
    });

    test("a store that never carried a pointer is left alone", () => {
        const root = tempStore();
        makeFarm(root, "catalog");
        removeStaleActiveFarmPointer(root);
        expect(readdirSync(root)).toEqual(["farms"]);
    });

    test("a real directory named `current` is not a pointer, thus it stays", () => {
        const root = tempStore();
        mkdirSync(join(root, "current"), { recursive: true });
        writeFileSync(join(root, "current", "mine.txt"), "x");
        removeStaleActiveFarmPointer(root);
        expect(existsSync(join(root, "current", "mine.txt"))).toBe(true);
    });
});

describe("reclaim — preview then remove", () => {
    test("previews unreferenced packages and runs --reclaim offline", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        mkdirSync(join(root, "store", "bar-2.0-bbb"), { recursive: true });
        // The catalog template holds the reference. A farm named for an analysis that the database does not
        // hold is an ORPHAN, and the reaper of the reclamation removes it before the preview — refer to the
        // reaper block below.
        mkdirSync(join(root, "farms", "catalog", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/foo-1.0-aaa", join(root, "farms", "catalog", "python", "site-packages", "foo"));

        const preview = await reclaimPreview(root);
        expect(preview.isOk()).toBe(true);
        if (preview.isOk()) expect(preview.value).toEqual(["bar-2.0-bbb"]);

        const { runner, calls } = spyRunner(SUCCESS);
        const result = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined) });
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.reclaimed).toEqual(["bar-2.0-bbb"]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual(["--reclaim"]);
        expect(calls[0]!.network).toBe("offline");
    });

    test("runs no container when every package is referenced", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        mkdirSync(join(root, "farms", "catalog", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/foo-1.0-aaa", join(root, "farms", "catalog", "python", "site-packages", "foo"));
        const image = spyEnsureImage();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: image.ensureImage });
        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(0);
        // Nothing to remove is nothing to pull either: a clean store costs neither an image nor an engine.
        expect(image.calls).toBe(0);
    });
});

describe("removeFarm", () => {
    test("passes --remove-farm offline and maps exit 2 to farm_not_found", async () => {
        const root = tempStore();
        const missing = spyRunner({ code: 2, stdout: "[provision] remove-farm: no such farm gone\n", stderr: "" });
        const result = await removeFarm({ storeRoot: root, farm: "gone" }, { run: missing.runner, ensureImage: async () => ok(undefined) });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("farm_not_found");
        expect(missing.calls[0]!.args).toEqual(["--remove-farm", "gone"]);
        expect(missing.calls[0]!.network).toBe("offline");
    });

    test("reports success on a clean exit", async () => {
        const root = tempStore();
        const { runner } = spyRunner(SUCCESS);
        const result = await removeFarm({ storeRoot: root, farm: "f1" }, { run: runner, ensureImage: async () => ok(undefined) });
        expect(result.isOk()).toBe(true);
    });
});

describe("inspectStore — read-only", () => {
    test("reports the packages and the farms, and it names no active farm", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "scanpy-1.9-aaa"), { recursive: true });
        writeFileSync(join(root, "store", "scanpy-1.9-aaa", ".inflexa-pin"), "scanpy==1.9\n");
        makeFarm(root, "catalog");
        mkdirSync(join(root, "farms", "catalog", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/scanpy-1.9-aaa", join(root, "farms", "catalog", "python", "site-packages", "scanpy"));

        const result = await inspectStore(root);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value.exists).toBe(true);
            expect(result.value.packages).toEqual([{ dir: "scanpy-1.9-aaa", pin: "scanpy==1.9" }]);
            const farm = result.value.farms.find((entry) => entry.name === "catalog");
            expect(farm?.template).toBe(true);
            expect(farm?.links).toBeGreaterThanOrEqual(1);
            // No pointer exists at the store level, thus the inspection carries no active-farm field at all.
            expect("active" in result.value).toBe(false);
        }
    });

    // Task 6.2: the listing names the analysis of each analysis farm, and it marks the template.
    test("names the analysis of each analysis farm and marks the catalog farm as the template", async () => {
        const root = tempStore();
        const analysis = seedAnalysis("Bulk RNA study");
        makeFarm(root, "catalog");
        makeFarm(root, analysis.id);
        // A farm whose analysis the database no longer holds is a normal disagreement, not a failure.
        makeFarm(root, "0197ffff-dead-7000-8000-000000000000");

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        const byName = (name: string) => inspection.farms.find((farm) => farm.name === name)!;
        expect(byName("catalog").template).toBe(true);
        expect(byName("catalog").analysisName).toBeNull();
        expect(byName(analysis.id).template).toBe(false);
        expect(byName(analysis.id).analysisName).toBe("Bulk RNA study");
        expect(byName("0197ffff-dead-7000-8000-000000000000").analysisName).toBeNull();
    });

    test("reports the track set each farm records", async () => {
        const root = tempStore();
        makeFarm(root, "python-only", ["python"]);
        makeFarm(root, "full", ["python", "r"]);
        // A farm with no readable metadata reports no track rather than failing the inspection.
        mkdirSync(join(root, "farms", "bare"), { recursive: true });

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        const tracksOf = (name: string): readonly string[] => inspection.farms.find((farm) => farm.name === name)!.tracks;
        expect(tracksOf("python-only")).toEqual(["python"]);
        expect(tracksOf("full")).toEqual(["python", "r"]);
        expect(tracksOf("bare")).toEqual([]);
    });

    test("reports the reclaimable bytes held by store content no farm references", async () => {
        const root = tempStore();
        // One package a farm links, and one orphan a reclaim would remove. An update keeps the orphan on
        // disk, so the listing reports its bytes.
        mkdirSync(join(root, "store", "kept-1.0-aaa"), { recursive: true });
        writeFileSync(join(root, "store", "kept-1.0-aaa", "data"), "x".repeat(100));
        mkdirSync(join(root, "store", "orphan-2.0-bbb"), { recursive: true });
        writeFileSync(join(root, "store", "orphan-2.0-bbb", "data"), "y".repeat(500));
        makeFarm(root, "default");
        mkdirSync(join(root, "farms", "default", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/kept-1.0-aaa", join(root, "farms", "default", "python", "site-packages", "kept"));

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        // Only the orphan is reclaimable; the referenced package is spared.
        expect(inspection.reclaimableBytes).toBe(500);
    });

    test("reports an absent store as not present", async () => {
        const result = await inspectStore(join(tempStore(), "does-not-exist"));
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.exists).toBe(false);
    });
});

// Invariant: no command other than reclaim and remove-farm removes store content. `inspectStore` and
// `reclaimPreview` take no container seam, so they can only read; the acquisition path is checked to
// carry no removal flag, and the removal commands are the only ones that emit `--reclaim` /
// `--remove-farm`.
describe("only reclaim and remove-farm remove store content", () => {
    test("the add path never emits a removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        await provisionPackages({ storeRoot: root, specs: ["scanpy", "anndata"] }, { run: runner, ensureImage: async () => ok(undefined) });
        for (const flag of ["--reclaim", "--remove-farm", "--repair"]) expect(calls[0]!.args).not.toContain(flag);
    });

    test("inspection reads without a container run", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        // inspectStore accepts no runner seam, so no container invocation is even representable; a plain
        // read is the only thing it can do.
        const result = await inspectStore(root);
        expect(result.isOk()).toBe(true);
    });

    test("the migration step keeps every farm and every package", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        makeFarm(root, "0197ffff-dead-7000-8000-000000000001");
        makeFarm(root, "catalog");
        symlinkSync("farms/catalog", join(root, "current"));
        removeStaleActiveFarmPointer(root);
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.farms.map((farm) => farm.name)).toEqual(["0197ffff-dead-7000-8000-000000000001", "catalog"]);
        expect(inspection.packages.map((pkg) => pkg.dir)).toEqual(["foo-1.0-aaa"]);
    });
});

// Real acquisition: the tests above stub the container, so they prove the argument building and the
// exit-code classification only. This block drives the REAL provisioner against a throwaway store, so it
// proves the host half end to end — the pool holds the distribution as a content-addressed directory.
//
// The sandbox half — importing the package through the read-only mount at uid 1000 — is proven by
// scripts/lib-store-sandbox-checks.sh, and is not duplicated here.

/** The local provisioner image the store scripts build; the block skips when it is absent. */
const LOCAL_PROVISIONER_IMAGE = "inflexa-provisioner:local";

/**
 * True only when podman is installed and the provisioner image is present locally. A missing binary, a
 * stopped podman machine, or an absent image all read as "not present", so the block skips cleanly rather
 * than failing the suite. A synchronous inspect keeps the module-scope gate simple.
 */
function provisionerImagePresent(): boolean {
    if (!Bun.which(runtimes.podman.bin)) return false;
    try {
        return Bun.spawnSync({ cmd: [runtimes.podman.bin, "image", "inspect", LOCAL_PROVISIONER_IMAGE], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
        return false;
    }
}

const imagePresent = provisionerImagePresent();

/**
 * Run the real provisioner through podman. This mirrors the module's default runner but pins the engine
 * AND the image: routing through `ensureRuntime` could pick docker on a machine that has both, and the
 * published reference the module names is not what the store scripts build locally. A fixed engine and a
 * local image keep the test deterministic and pull nothing.
 */
const podmanRunner: ProvisionerRunner = async (invocation, onLine) => {
    const args = [
        "run",
        "--rm",
        ...(invocation.network === "offline" ? ["--network", "none"] : []),
        "-v",
        runtimes.podman.mountArg(invocation.storeRoot, "/mnt/libs"),
        LOCAL_PROVISIONER_IMAGE,
        ...invocation.args,
    ];
    return ok(await stream(runtimes.podman, args, onLine));
};

describe.skipIf(!imagePresent)("store add — the real acquisition path (podman + inflexa-provisioner:local)", () => {
    test("acquires six, and the pool holds it as a content-addressed directory", async () => {
        const root = tempStore();
        // The image is already present, so the real ensure step would be a no-op; stub it so the test
        // never reaches a registry.
        const result = await provisionPackages({ storeRoot: root, specs: ["six"] }, { run: podmanRunner, ensureImage: async () => ok(undefined) });

        // An Err here is a real acquisition failure — the message carries the provisioner's tail.
        expect(result._unsafeUnwrap().specs).toEqual(["six"]);

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.exists).toBe(true);
        expect(inspection.packages.some((pkg) => pkg.dir.startsWith("six-"))).toBe(true);
        // The acquisition names no farm, thus it builds none, and the graph is what records the result.
        expect(inspection.farms).toEqual([]);
        expect(existsSync(join(root, "deps.json"))).toBe(true);
    }, 180_000);
});

// --- reclaim against the acquisition flights (task 4.9) ----------------------
//
// A reclaim frees pool content, and a flight is about to reference it. The two are exclusive in both
// directions: a reclaim waits for the flights it found, and it blocks a new one for its whole run.

// --- the orphan-farm reaper (task 2.4) ---------------------------------------
//
// `analysis delete` removes the farm of the analysis. This pass exists for what that route cannot cover:
// a database the user replaced or removed, and a delete a crash stopped between the two stores. It runs
// ONLY inside the reclaim command, because reclamation is never implicit.

describe("the orphan-farm reaper of the reclamation", () => {
    /** A farm that links one store directory, so the reaper's removal frees pool content. */
    function farmLinking(root: string, name: string, storeDir: string): string {
        const dir = join(root, "farms", name, "python", "site-packages");
        mkdirSync(dir, { recursive: true });
        symlinkSync(`/mnt/libs/store/${storeDir}`, join(dir, storeDir.split("-")[0]!));
        return join(root, "farms", name);
    }

    test("a farm whose analysis is gone is removed, and its content is then reclaimed", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        mkdirSync(join(root, "store", "bar-2.0-bbb"), { recursive: true });
        const live = seedAnalysis("kept");
        const kept = farmLinking(root, live.id, "foo-1.0-aaa");
        const orphan = farmLinking(root, randomUUIDv7(), "bar-2.0-bbb");

        const { runner, calls } = spyRunner(SUCCESS);
        const outcome = (await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined) }))._unsafeUnwrap();

        expect(outcome.farmsReaped).toEqual([basename(orphan)]);
        expect(existsSync(orphan)).toBe(false);
        expect(existsSync(kept)).toBe(true);
        // The reaper runs BEFORE the preview, thus the content the orphan alone held is reclaimable now.
        expect(outcome.reclaimed).toEqual(["bar-2.0-bbb"]);
        expect(calls).toHaveLength(1);
    });

    test("the catalog template is never an orphan, because it belongs to no analysis", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        const template = farmLinking(root, "catalog", "foo-1.0-aaa");

        const { runner } = spyRunner(SUCCESS);
        const outcome = (await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined) }))._unsafeUnwrap();

        expect(outcome.farmsReaped).toEqual([]);
        expect(existsSync(template)).toBe(true);
        expect(outcome.reclaimed).toEqual([]);
    });

    test("a lease that records a live sandbox keeps the farm, because that sandbox resolves it now", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        const orphanId = randomUUIDv7();
        const orphan = farmLinking(root, orphanId, "foo-1.0-aaa");
        mkdirSync(join(root, "leases"), { recursive: true });
        writeFileSync(join(root, "leases", "sandbox-1"), JSON.stringify({ lease: "sandbox-1", farm: orphanId }));

        const { runner } = spyRunner(SUCCESS);
        const outcome = (await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined) }))._unsafeUnwrap();

        expect(outcome.farmsReaped).toEqual([]);
        expect(existsSync(orphan)).toBe(true);
        expect(outcome.reclaimed).toEqual([]);
    });
});

describe("reclaim is exclusive against the live flights", () => {
    test("a live flight holds the reclaim, and it refuses when the wait runs out", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "orphan-1.0-aaa"), { recursive: true });
        const held = Promise.withResolvers<void>();
        const spec = parseLibStoreFlightSpec("scanpy", "python")._unsafeUnwrap();
        const flight = withLibStoreFlight(
            { spec, analysisId: null },
            async () => {
                await held.promise;
                return ok(undefined);
            },
            { pollMs: 5 },
        );
        await Promise.sleep(30);

        const { runner, calls } = spyRunner(SUCCESS);
        const refused = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined), flightWaitMs: 20, flightPollMs: 5 });
        const error = refused._unsafeUnwrapErr();
        expect(error.type).toBe("acquisition_in_flight");
        expect(error.message).toContain("scanpy");
        // Nothing was deleted, thus the reclaim freed nothing the flight was about to reference.
        expect(calls).toEqual([]);
        expect(existsSync(join(root, "store", "orphan-1.0-aaa"))).toBe(true);

        // Once the flight ends the same reclaim runs, and it removes exactly the unreferenced directory.
        held.resolve();
        await flight;
        const done = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined), flightWaitMs: 20, flightPollMs: 5 });
        expect(done._unsafeUnwrap().reclaimed).toEqual(["orphan-1.0-aaa"]);
    });

    test("a live reclaim blocks a new flight, and the flight names it", async () => {
        // A live foreign holder, because our own pid takes the lock re-entrantly and would block nothing.
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(dirname(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY)), { recursive: true });
        writeFileSync(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY), String(holder.pid));
        try {
            const spec = parseLibStoreFlightSpec("scanpy", "python")._unsafeUnwrap();
            let ran = 0;
            const refused = await withLibStoreFlight(
                { spec, analysisId: null },
                async () => {
                    ran += 1;
                    return ok(undefined);
                },
                { pollMs: 5, reclaimWaitMs: 20 },
            );
            const error = refused._unsafeUnwrapErr();
            expect(error.type).toBe("reclaim_in_flight");
            // The work never ran, thus the reclaim scanned a pool that no flight was writing.
            expect(ran).toBe(0);
            expect(readLibStoreFlights()).toEqual([]);
        } finally {
            holder.kill();
            await holder.exited;
            rmSync(instanceLockPath(LIB_STORE_RECLAIM_LOCK_KEY), { force: true });
        }
    });
});

// --- reclaim against the live farm compositions -------------------------------
//
// A composition walks the graph and links what the pool holds, thus a reclaim between the walk and the
// link would free a store directory that the farm is about to reference. The per-farm lock is the
// liveness record of a composition, and the reclaim waits for each live holder of that key family.

describe("reclaim is exclusive against the live compositions", () => {
    /** A live foreign holder of one per-farm key, which is what a composition of another process leaves. */
    function liveComposition(): { readonly key: string; readonly pid: number; readonly stop: () => Promise<void> } {
        const holder = Bun.spawn(["sleep", "60"]);
        const key = `farm-${randomUUIDv7()}`;
        mkdirSync(dirname(instanceLockPath(key)), { recursive: true });
        writeFileSync(instanceLockPath(key), String(holder.pid));
        return {
            key,
            pid: holder.pid,
            stop: async () => {
                holder.kill();
                await holder.exited; // awaited so the child is reaped and the pid probe reports it dead
                rmSync(instanceLockPath(key), { force: true });
            },
        };
    }

    test("a reclaim waits for a live composition, and it deletes only after that composition finishes", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "orphan-1.0-aaa"), { recursive: true });
        const composition = liveComposition();

        const { runner, calls } = spyRunner(SUCCESS);
        const reclaiming = reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined), flightWaitMs: 5_000, flightPollMs: 5 });
        await Promise.sleep(50);
        // Nothing ran, thus the reclaim freed nothing the composition was about to link.
        expect(calls).toEqual([]);
        expect(existsSync(join(root, "store", "orphan-1.0-aaa"))).toBe(true);

        await composition.stop();

        expect((await reclaiming)._unsafeUnwrap().reclaimed).toEqual(["orphan-1.0-aaa"]);
    });

    test("a live composition holds the reclaim, and it refuses with the pid when the wait runs out", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "orphan-1.0-aaa"), { recursive: true });
        const composition = liveComposition();

        try {
            const { runner, calls } = spyRunner(SUCCESS);
            const refused = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined), flightWaitMs: 20, flightPollMs: 5 });

            const error = refused._unsafeUnwrapErr();
            expect(error.type).toBe("composition_in_flight");
            expect(error.message).toContain(String(composition.pid));
            expect(calls).toEqual([]);
            expect(existsSync(join(root, "store", "orphan-1.0-aaa"))).toBe(true);
        } finally {
            await composition.stop();
        }
    });

    test("a composition record whose process is gone blocks nothing, and the reclaim sweeps it", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "orphan-1.0-aaa"), { recursive: true });
        const composition = liveComposition();
        await composition.stop();
        // The record alone, with no live process behind it.
        writeFileSync(instanceLockPath(composition.key), String(composition.pid));

        const { runner } = spyRunner(SUCCESS);
        const done = await reclaimStore({ storeRoot: root }, { run: runner, ensureImage: async () => ok(undefined), flightWaitMs: 20, flightPollMs: 5 });

        expect(done._unsafeUnwrap().reclaimed).toEqual(["orphan-1.0-aaa"]);
        expect(existsSync(instanceLockPath(composition.key))).toBe(false);
    });
});

// --- the live-download refusal and the download readout ----------------------
//
// A download merges its staged tree into the store root one child at a time, so a provisioning run that
// writes into the same pool during that merge can meet a half-merged root. The refusal covers the whole
// live period, and a dead downloader refuses nothing.

/** Drop the lifecycle row and the download lock, so each test starts from a machine on which nothing ran. */
function resetDownloadLifecycle(): void {
    releaseInstanceLock(LIB_STORE_DOWNLOAD_LOCK_KEY);
    rmSync(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY), { force: true });
    db()
        .map((conn) => conn.query("DELETE FROM lib_store_downloads").run())
        ._unsafeUnwrap();
}

/** Seed the download lock with `pid`, the way a live downloader of that pid would hold it. */
function seedDownloadLock(pid: number): void {
    mkdirSync(dirname(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY)), { recursive: true });
    writeFileSync(instanceLockPath(LIB_STORE_DOWNLOAD_LOCK_KEY), String(pid));
}

// --- the farm extension at the end of a flight (tasks 4.7, 4.10, 9.7) --------
//
// `store add` acquires into the pool and does no farm work in the container. Each CALLER then extends its
// own farm and no other farm, when its own call resolves. Two identical adds share one flight, thus one
// acquisition serves both callers, and each of the two extends the farm that it named.

describe("each caller of a flight extends its own farm", () => {
    const OMEGA = "omega-9.9-0000000000009999";
    const BETA = "beta-0.4.1-000000000000bbbb";

    /** A store root that carries the fixture pool, its graph, and a catalog template farm. */
    function composableStore(): string {
        const root = tempStore();
        seedComposablePool(root);
        return root;
    }

    /** Give an analysis the farm that its creation makes, so an extension has a farm to reach. */
    async function seedFarm(root: string, analysisId: string): Promise<void> {
        expect((await extendFarm({ storeRoot: root, analysisId, roots: [BETA] })).isOk()).toBe(true);
    }

    /**
     * Report whether the farm of an analysis links one top-level name.
     *
     * `lstat` and not `existsSync`, because a farm link points at `/mnt/libs`, which is the path INSIDE
     * the sandbox. Each link is thus dangling on the host, and a test that follows one reads every farm
     * as empty.
     */
    function farmLinks(root: string, analysisId: string, name: string): boolean {
        try {
            return lstatSync(join(root, "farms", analysisId, "python", "site-packages", name)).isSymbolicLink();
        } catch {
            return false;
        }
    }

    /**
     * Drive one caller of `store add`, in the shape `acquireOneSpec` has: read the baseline, fly the
     * spec, then extend the farm of THIS caller and of no other.
     */
    async function addOneSpec(params: {
        readonly root: string;
        readonly raw: string;
        readonly analysisId: string | null;
        readonly runner: ProvisionerRunner;
        readonly hold?: Promise<void>;
    }): Promise<void> {
        const spec = parseLibStoreFlightSpec(params.raw, "python")._unsafeUnwrap();
        const baseline = new Set(readDepsGraph(params.root)._unsafeUnwrap().nodes.keys());
        const outcome = await withLibStoreFlight(
            { spec, analysisId: params.analysisId },
            async () => {
                await params.hold;
                return provisionPackages({ storeRoot: params.root, specs: [spec.name] }, { run: params.runner, ensureImage: async () => ok(undefined) });
            },
            { pollMs: 5 },
        );
        expect(outcome.isOk()).toBe(true);
        if (params.analysisId !== null && outcome.isOk() && outcome.value.type !== "canceled") {
            await extendFarmForFlight({ storeRoot: params.root, spec, analysisId: params.analysisId, baseline });
        }
    }

    test("two identical adds share one flight, and each caller extends the farm that it named", async () => {
        assertTestSandbox(env.locksDir);
        const root = composableStore();
        const first = seedAnalysis("first");
        const second = seedAnalysis("second");
        for (const analysis of [first, second]) await seedFarm(root, analysis.id);
        for (const analysis of [first, second]) expect(farmLinks(root, analysis.id, "omega")).toBe(false);

        const held = Promise.withResolvers<void>();
        const { runner, calls } = spyRunner(SUCCESS);
        // One call for each analysis, over one spec. The owner runs the work and the second call
        // subscribes to it, thus one provisioner container runs. Each call then extends its OWN farm.
        const adds = [first, second].map((analysis) => addOneSpec({ root, raw: "omega", analysisId: analysis.id, runner, hold: held.promise }));
        await Promise.sleep(40);
        held.resolve();
        await Promise.all(adds);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual(["omega"]);
        for (const analysis of [first, second]) {
            const link = join(root, "farms", analysis.id, "python", "site-packages", "omega");
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(readlinkSync(link)).toBe(`/mnt/libs/store/${OMEGA}/omega`);
            // The extension is additive: what the farm already held is still there.
            expect(lstatSync(join(root, "farms", analysis.id, "python", "site-packages", "beta")).isSymbolicLink()).toBe(true);
        }
    });

    // Task 9.7. The named analysis is the one whose farm grows, and an add that names none grows nothing.
    test("an add that names an analysis extends that farm, and an add that names none extends no farm", async () => {
        assertTestSandbox(env.locksDir);
        const root = composableStore();
        const named = seedAnalysis("named");
        const other = seedAnalysis("other");
        for (const analysis of [named, other]) await seedFarm(root, analysis.id);
        const { runner } = spyRunner(SUCCESS);

        await addOneSpec({ root, raw: "omega", analysisId: named.id, runner });
        expect(farmLinks(root, named.id, "omega")).toBe(true);
        // The farm of the other analysis is untouched: a caller extends its own farm and no other.
        expect(farmLinks(root, other.id, "omega")).toBe(false);

        await addOneSpec({ root, raw: "gamma", analysisId: null, runner });
        // The acquisition belongs to no analysis, thus no farm on the machine gained the package.
        for (const analysis of [named, other]) expect(farmLinks(root, analysis.id, "gamma")).toBe(false);
    });

    test("an analysis whose farm is absent is skipped, and the extension makes no farm", async () => {
        assertTestSandbox(env.locksDir);
        const root = composableStore();
        const analysis = seedAnalysis("no farm");

        await extendFarmForFlight({
            storeRoot: root,
            spec: parseLibStoreFlightSpec("omega", "python")._unsafeUnwrap(),
            analysisId: analysis.id,
            baseline: new Set(),
        });

        // The farm of an analysis is made with the analysis, thus this path links into one and makes none.
        expect(existsSync(join(root, "farms", analysis.id))).toBe(false);
    });

    // Task 9.4. A `--analysis` that resolves to nothing is a named refusal, before any container starts.
    test("an `--analysis` that names no analysis is refused, and no flight starts", async () => {
        assertTestSandbox(env.locksDir);
        const reported: string[] = [];
        const originalError = console.error;
        const originalExitCode = process.exitCode;
        console.error = (...args: unknown[]): void => void reported.push(args.map(String).join(" "));
        try {
            await runStoreAdd(["scanpy"], { analysis: "no-analysis-by-this-name" });
        } finally {
            console.error = originalError;
            // `reportError` marks the process failed, which must not outlive the test that asked for it.
            process.exitCode = originalExitCode;
        }

        expect(reported.join("\n")).toContain('No analysis matches "no-analysis-by-this-name"');
        expect(readLibStoreFlights()).toEqual([]);
    });
});

// --- `store link` (tasks 9.1, 9.2, 9.3, 9.6) ---------------------------------
//
// `link` is the other half of `add`, and it is a command of its own. It links what the pool already holds
// into the farm of one analysis: it starts no container, it opens no network connection, and it asks for
// no consent. The `auto` policy of the command rests on exactly those three facts, thus this block proves
// each one. The policy itself is pinned in `cli/agent_policy_tree.test.ts`.

describe("store link — it links from the pool, and it acquires nothing", () => {
    const ALPHA_NEW = "alpha-2.0.0-00000000000a2222";
    const ALPHA_OLD = "alpha-1.2.0-000000000000aaaa";

    beforeEach(() => {
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
        seedComposablePool(env.libStoreDir);
    });
    afterEach(() => {
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });

    /**
     * Run an action with both spawn calls counted.
     *
     * A container start goes through `Bun.spawn` (`lib/container.ts`), and so does the detached download.
     * A count of zero is thus the proof that the action started no provisioner, no engine, and no other
     * child — and with no child there is no network connection either, because the store opens one only
     * inside the provisioner container.
     */
    async function countSpawns(run: () => Promise<void>): Promise<number> {
        const spawn = Bun.spawn;
        const spawnSync = Bun.spawnSync;
        let spawns = 0;
        // The two casts keep the overload set of each original, which a plain wrapper signature would
        // drop. They are sound because each wrapper forwards its arguments to the original unchanged.
        Bun.spawn = ((...args: Parameters<typeof spawn>) => {
            spawns += 1;
            return spawn(...args);
        }) as typeof spawn;
        Bun.spawnSync = ((...args: Parameters<typeof spawnSync>) => {
            spawns += 1;
            return spawnSync(...args);
        }) as typeof spawnSync;
        try {
            await run();
        } finally {
            Bun.spawn = spawn;
            Bun.spawnSync = spawnSync;
        }
        return spawns;
    }

    /** Run a command action with both streams captured, so the report is assertable and the suite stays quiet. */
    async function report(run: () => Promise<void>): Promise<string> {
        const lines: string[] = [];
        const log = console.log;
        const error = console.error;
        const exitCode = process.exitCode;
        console.log = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
        console.error = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
        try {
            await run();
        } finally {
            console.log = log;
            console.error = error;
            // `reportError` marks the process failed, which must not outlive the test that asked for it.
            process.exitCode = exitCode;
        }
        return lines.join("\n");
    }

    /** The target of one top-level link of a farm, or `null` when the farm holds no such link. */
    function linkTarget(analysisId: string, name: string): string | null {
        try {
            return readlinkSync(join(env.libStoreDir, "farms", analysisId, "python", "site-packages", name));
        } catch {
            return null;
        }
    }

    test("a package the pool holds links into the named farm, and no container, no network, and no prompt is reached", async () => {
        const analysis = seedAnalysis("link target");
        let output = "";
        const spawns = await countSpawns(async () => {
            output = await report(() => runStoreLink(["omega"], { analysis: analysis.id }));
        });

        expect(linkTarget(analysis.id, "omega")).toBe("/mnt/libs/store/omega-9.9-0000000000009999/omega");
        expect(output).toContain("Linked omega==9.9");
        expect(output).toContain('the farm of "link target"');
        // No child process ran, thus no provisioner container started and nothing reached the network.
        expect(spawns).toBe(0);
        // An acquisition is the only path of this module that opens the network, and it takes a flight.
        expect(readLibStoreFlights()).toEqual([]);
    });

    test("the closure of the package links too, thus the farm resolves what the package imports", async () => {
        const analysis = seedAnalysis("link closure");
        await report(() => runStoreLink(["beta"], { analysis: analysis.id }));
        // `beta` names `alpha-1.2.0` as an edge, thus the walk links the dependency and not the head of
        // the `alpha` ordering.
        expect(linkTarget(analysis.id, "beta")).toBe("/mnt/libs/store/beta-0.4.1-000000000000bbbb/beta");
        expect(linkTarget(analysis.id, "alpha")).toBe(`/mnt/libs/store/${ALPHA_OLD}/alpha`);
    });

    // Task 9.2. The emitter settles the order of the versions, thus a request with no version takes the
    // head of that list and the host compares no two version strings.
    test("a request with no version takes the head of the ordering, and `==` takes the exact version", async () => {
        const newest = seedAnalysis("newest");
        const pinned = seedAnalysis("pinned");
        await report(() => runStoreLink(["alpha"], { analysis: newest.id }));
        expect(linkTarget(newest.id, "alpha")).toBe(`/mnt/libs/store/${ALPHA_NEW}/alpha`);

        const output = await report(() => runStoreLink(["alpha==1.2.0"], { analysis: pinned.id }));
        expect(linkTarget(pinned.id, "alpha")).toBe(`/mnt/libs/store/${ALPHA_OLD}/alpha`);
        expect(output).toContain("Linked alpha==1.2.0");
    });

    // Task 9.3. A package the pool does not hold is a refusal that names the package and the remedy.
    test("a package the pool does not hold refuses, names it, and names the acquisition command", async () => {
        const analysis = seedAnalysis("absent package");
        const output = await report(() => runStoreLink(["polars"], { analysis: analysis.id }));

        expect(output).toContain('holds nothing named "polars"');
        expect(output).toContain("inflexa store add polars");
        // The whole call resolves before one link is written, thus the farm was never made.
        expect(existsSync(join(env.libStoreDir, "farms", analysis.id))).toBe(false);
    });

    // Task 9.3. An R package carries a reason of its own, because this store acquires none at all. A
    // generic "not found" would send a person, or an agent, around the same loop for ever.
    test("an R package the pool does not hold says that no retry succeeds", async () => {
        const analysis = seedAnalysis("absent r package");
        const output = await report(() => runStoreLink(["rpkga==9.9"], { analysis: analysis.id }));

        expect(output).toContain('R package "rpkga"');
        expect(output).toContain("no retry");
        // It still names what the pool does hold, so the reader can link that version instead.
        expect(output).toContain("1.0");
        expect(existsSync(join(env.libStoreDir, "farms", analysis.id))).toBe(false);
    });

    // Task 9.2 and 9.3. A version the pool does not hold names the versions that it does hold, and a
    // Python package carries no R reason, because a retry of it can succeed.
    test("a version the pool does not hold names the versions that it holds", async () => {
        const analysis = seedAnalysis("absent version");
        const output = await report(() => runStoreLink(["alpha==9.9"], { analysis: analysis.id }));

        expect(output).toContain("no version 9.9");
        expect(output).toContain("2.0.0");
        expect(output).toContain("1.2.0");
        expect(output).toContain("inflexa store add alpha==9.9");
        expect(output).not.toContain("no retry");
    });

    test("one package the pool does not hold refuses the whole call, thus the farm keeps exactly what it had", async () => {
        const analysis = seedAnalysis("mixed call");
        await report(() => runStoreLink(["omega"], { analysis: analysis.id }));
        const output = await report(() => runStoreLink(["alpha", "polars"], { analysis: analysis.id }));

        expect(output).toContain("polars");
        expect(linkTarget(analysis.id, "alpha")).toBeNull();
        expect(linkTarget(analysis.id, "omega")).toBe("/mnt/libs/store/omega-9.9-0000000000009999/omega");
    });

    // Task 9.1. A link with no farm has no meaning, thus a call that names no analysis refuses. The root
    // command declares `--analysis` too, so commander cannot make the flag mandatory here — refer to the
    // registration in `cli/index.ts` — and the action itself is what refuses.
    test("a call that names no analysis refuses, and it links nothing", async () => {
        const spawns = await countSpawns(async () => {
            const output = await report(() => runStoreLink(["omega"], { analysis: null }));
            expect(output).toContain("--analysis <id|name>");
        });
        expect(spawns).toBe(0);
        expect(readdirSync(join(env.libStoreDir, "farms"))).toEqual(["catalog"]);
    });

    test("an `--analysis` that names no analysis refuses before the pool is read", async () => {
        const output = await report(() => runStoreLink(["omega"], { analysis: "no-analysis-by-this-name" }));
        expect(output).toContain('No analysis matches "no-analysis-by-this-name"');
        expect(readdirSync(join(env.libStoreDir, "farms"))).toEqual(["catalog"]);
    });
});

describe("store add refuses while a download is live", () => {
    beforeEach(() => resetDownloadLifecycle());
    afterEach(() => resetDownloadLifecycle());

    test("a live download refuses the provisioning run, names it, and writes nothing to the store root", async () => {
        const root = join(tempStore(), "fresh");
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        seedDownloadLock(process.pid);

        const { runner, calls } = spyRunner(SUCCESS);
        const ensure = spyEnsureImage();
        const result = await provisionPackages({ storeRoot: root, specs: ["scanpy"] }, { run: runner, ensureImage: ensure.ensureImage });

        const error = result._unsafeUnwrapErr();
        expect(error.type).toBe("download_in_flight");
        expect(error.message).toContain("inflexa store cancel");
        expect(error.message).toContain("inflexa store ls");
        // Nothing ran and nothing was written: the refusal lands before the image seam and before the
        // store root is even created.
        expect(calls).toEqual([]);
        expect(ensure.calls).toBe(0);
        expect(existsSync(root)).toBe(false);
    });

    test("a `running` row whose holder is gone refuses nothing, because it reads as failed", async () => {
        const root = tempStore();
        startLibStoreDownloadRun({ state: "running", holderPid: 999_999 })._unsafeUnwrap();
        // No lock file: nothing live holds the key.
        const { runner, calls } = spyRunner(SUCCESS);
        const ensure = spyEnsureImage();
        const result = await provisionPackages({ storeRoot: root, specs: ["scanpy"] }, { run: runner, ensureImage: ensure.ensureImage });

        expect(result.isOk()).toBe(true);
        expect(calls.length).toBe(1);
    });
});

describe("inspectStore — the download readout", () => {
    beforeEach(() => resetDownloadLifecycle());
    afterEach(() => resetDownloadLifecycle());

    test("an absent row reports that no download ran, because a store can arrive by a route that wrote none", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.download.state).toBeNull();
        expect(inspection.download.updateAvailable).toBe(false);
    });

    test("a live transfer reports its state and its two byte figures", async () => {
        const root = tempStore();
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:a", totalBytes: 900, totalLayers: 3 })._unsafeUnwrap();
        recordLibStoreDownloadProgress({ bytesTransferred: 300, layersCompleted: 1 })._unsafeUnwrap();
        seedDownloadLock(process.pid);

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.download.state).toBe("running");
        expect(inspection.download.bytesTransferred).toBe(300);
        expect(inspection.download.totalBytes).toBe(900);
    });

    test("a failure reports its message, which names the fault and the remedy", async () => {
        const root = tempStore();
        settleLibStoreDownload({ state: "failed", message: "The registry was unreachable. Run `inflexa store download` to try again." })._unsafeUnwrap();
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.download.state).toBe("failed");
        expect(inspection.download.message).toContain("inflexa store download");
    });

    test("a canceled run is reported as its own state, separate from a declined one", async () => {
        const root = tempStore();
        settleLibStoreDownload({ state: "canceled", message: null })._unsafeUnwrap();
        expect((await inspectStore(root))._unsafeUnwrap().download.state).toBe("canceled");
        settleLibStoreDownload({ state: "declined", message: null })._unsafeUnwrap();
        expect((await inspectStore(root))._unsafeUnwrap().download.state).toBe("declined");
    });

    test("a receipt that pins a different manifest than the last resolve reports an available update", async () => {
        const root = tempStore();
        // The receipt is what is installed; the row carries the digest the registry serves now.
        mkdirSync(libStoreDownloadPaths(root).metadata, { recursive: true });
        writeFileSync(
            libStoreDownloadPaths(root).receipt,
            JSON.stringify({
                version: 1,
                manifestDigest: "sha256:a",
                reference: "latest-arm64",
                arch: "arm64",
                activatedAt: "2026-01-01T00:00:00Z",
                layers: [],
            }),
        );
        settleLibStoreDownload({ state: "installed", message: null })._unsafeUnwrap();
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:b", totalBytes: 900, totalLayers: 3 })._unsafeUnwrap();

        expect((await inspectStore(root))._unsafeUnwrap().download.updateAvailable).toBe(true);

        // The same digest on both sides is a store that is up to date, and no surface offers an update.
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:a", totalBytes: 900, totalLayers: 3 })._unsafeUnwrap();
        expect((await inspectStore(root))._unsafeUnwrap().download.updateAvailable).toBe(false);
    });
});

describe("runStoreLs — the listing reports the download and prompts for nothing", () => {
    beforeEach(() => {
        resetDownloadLifecycle();
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });
    afterEach(() => {
        resetDownloadLifecycle();
        assertTestSandbox(env.libStoreDir);
        rmSync(env.libStoreDir, { recursive: true, force: true });
    });

    /** Run a command action with stdout captured, so the report is assertable and the suite stays quiet. */
    async function output(run: () => Promise<void>): Promise<string> {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...args: unknown[]): void => void lines.push(args.map(String).join(" "));
        try {
            await run();
        } finally {
            console.log = original;
        }
        return lines.join("\n");
    }

    test("a live transfer is reported with its state and its byte figures", async () => {
        makeFarm(env.libStoreDir, "default");
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:a", totalBytes: 2048, totalLayers: 2 })._unsafeUnwrap();
        recordLibStoreDownloadProgress({ bytesTransferred: 1024, layersCompleted: 1 })._unsafeUnwrap();
        seedDownloadLock(process.pid);

        const report = await output(runStoreLs);
        expect(report).toContain("Download running");
        expect(report).toContain("1.0 KiB of 2.0 KiB");
    });

    test("a failure names its message and the retry command", async () => {
        makeFarm(env.libStoreDir, "default");
        settleLibStoreDownload({ state: "failed", message: "The registry was unreachable." })._unsafeUnwrap();
        const report = await output(runStoreLs);
        expect(report).toContain("Download failed");
        expect(report).toContain("The registry was unreachable.");
        expect(report).toContain("inflexa store download");
    });

    test("a canceled run says that the user stopped the transfer, and names the same retry", async () => {
        makeFarm(env.libStoreDir, "default");
        settleLibStoreDownload({ state: "canceled", message: null })._unsafeUnwrap();
        const report = await output(runStoreLs);
        expect(report).toContain("you stopped the transfer");
        expect(report).toContain("inflexa store download");
    });

    test("an absent row says that no download ran", async () => {
        makeFarm(env.libStoreDir, "default");
        expect(await output(runStoreLs)).toContain("no download ran");
    });

    test("an available update names `inflexa store download --update` and opens no prompt", async () => {
        makeFarm(env.libStoreDir, "default");
        mkdirSync(libStoreDownloadPaths(env.libStoreDir).metadata, { recursive: true });
        writeFileSync(
            libStoreDownloadPaths(env.libStoreDir).receipt,
            JSON.stringify({
                version: 1,
                manifestDigest: "sha256:a",
                reference: "latest-arm64",
                arch: "arm64",
                activatedAt: "2026-01-01T00:00:00Z",
                layers: [],
            }),
        );
        settleLibStoreDownload({ state: "installed", message: null })._unsafeUnwrap();
        recordLibStoreDownloadManifest({ manifestDigest: "sha256:b", totalBytes: 2048, totalLayers: 2 })._unsafeUnwrap();

        const report = await output(runStoreLs);
        expect(report).toContain("inflexa store download --update");
    });

    test("a cancel with no live run reports that fact and changes nothing", async () => {
        makeFarm(env.libStoreDir, "default");
        const report = await output(runStoreCancel);
        expect(report).toContain("No package-store download is running");
        expect(existsSync(join(env.libStoreDir, "farms", "default"))).toBe(true);
    });

    test("a start over a live run names the progress command and the cancel command", async () => {
        startLibStoreDownloadRun({ state: "running", holderPid: process.pid })._unsafeUnwrap();
        recordLibStoreDownloadProgress({ bytesTransferred: 1024, layersCompleted: 1 })._unsafeUnwrap();
        seedDownloadLock(process.pid);

        const report = await output(() => runStoreDownload({}));
        expect(report).toContain("already running");
        // A detached process writes nothing to the terminal of the starter, so the pointer is what a user
        // needs most.
        expect(report).toContain("inflexa store ls");
        expect(report).toContain("inflexa store cancel");
    });

    // Task 4.8: the listing names each live flight — its spec, its state, and the analyses subscribed.
    test("a live flight is reported with its spec, its state, and its subscribed analyses", async () => {
        makeFarm(env.libStoreDir, "catalog");
        const analysis = seedAnalysis("Single cell atlas");
        const spec = parseLibStoreFlightSpec("Scan_PY>=1.9", "python")._unsafeUnwrap();
        const id = libStoreFlightKey(spec);
        claimLibStoreFlight({ id, ecosystem: spec.ecosystem, name: spec.name, specifier: spec.specifier, holderPid: process.pid })._unsafeUnwrap();
        subscribeLibStoreFlight({ flightId: id, analysisId: analysis.id })._unsafeUnwrap();

        const report = await output(runStoreLs);
        expect(report).toContain("Flights  1");
        // The name is canonical, thus the readout names the flight and not the spelling of the request.
        expect(report).toContain("python scan-py>=1.9");
        expect(report).toContain("queued");
        expect(report).toContain("Single cell atlas");
    });

    // Task 6.2: the farm block names the analysis of each farm and marks the template, and it reports no
    // active-farm pointer at all.
    test("the farm block names each analysis, marks the template, and names no pointer", async () => {
        const analysis = seedAnalysis("Bulk RNA study");
        makeFarm(env.libStoreDir, "catalog");
        makeFarm(env.libStoreDir, analysis.id);

        const report = await output(runStoreLs);
        expect(report).toContain("catalog  template");
        expect(report).toContain(`${analysis.id}  analysis "Bulk RNA study"`);
        expect(report).not.toContain("Active");
        expect(report).not.toContain("inflexa store use");
    });
});
