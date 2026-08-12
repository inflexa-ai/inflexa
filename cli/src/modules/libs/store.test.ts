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
import { composeFarm, readDepsGraph } from "./composition.ts";
import { libStoreDownloadPaths } from "./store_download.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import {
    inspectStore,
    provisionPackages,
    reclaimPreview,
    reclaimStore,
    removeFarm,
    extendFarmsForFlight,
    removeStaleActiveFarmPointer,
    runStoreCancel,
    runStoreDownload,
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

// --- the farm extension at the flight commit (tasks 4.7, 4.10) ---------------
//
// `store add` acquires into the pool and does no farm work in the container. The farms change at the
// COMMIT of the flight: each analysis that subscribed gets the acquired closure linked into its farm. Two
// identical adds share one flight, thus one acquisition extends both farms.

describe("a successful flight extends the farm of each subscriber", () => {
    const OMEGA = "omega-9.9-0000000000009999";

    /** A store root that carries the fixture pool, its graph, and a catalog template farm. */
    function composableStore(): string {
        const root = tempStore();
        cpSync(join(import.meta.dir, "test-fixtures", "farm-parity"), root, { recursive: true });
        const template = join(root, "farms", "catalog");
        mkdirSync(join(template, "python", "site-packages"), { recursive: true });
        writeFileSync(
            join(template, "lock.json"),
            JSON.stringify({ requested: ["beta"], resolved: ["beta==0.4.1"], store_dirs: ["alpha-1.2.0-000000000000aaaa", "beta-0.4.1-000000000000bbbb"] }),
        );
        writeFileSync(join(template, "meta.json"), JSON.stringify({ version: "catalog", arch: "linux-arm64", tracks: ["python"] }));
        return root;
    }

    test("two identical adds share one flight, and both farms hold the acquired package", async () => {
        assertTestSandbox(env.locksDir);
        const root = composableStore();
        const first = seedAnalysis("first");
        const second = seedAnalysis("second");
        // Both analyses ran a sandbox already, thus both own a farm that an extension can reach.
        for (const analysis of [first, second]) expect((await composeFarm({ storeRoot: root, analysisId: analysis.id })).isOk()).toBe(true);
        for (const analysis of [first, second]) {
            expect(existsSync(join(root, "farms", analysis.id, "python", "site-packages", "omega"))).toBe(false);
        }

        const spec = parseLibStoreFlightSpec("omega", "python")._unsafeUnwrap();
        const baseline = new Set(readDepsGraph(root)._unsafeUnwrap().nodes.keys());
        const held = Promise.withResolvers<void>();
        const { runner, calls } = spyRunner(SUCCESS);
        // One flight for each analysis, over one spec. The owner runs the work, and the second call
        // subscribes to it — thus one provisioner container runs and both farms extend.
        const flights = [first, second].map((analysis) =>
            withLibStoreFlight(
                {
                    spec,
                    analysisId: analysis.id,
                    extendSubscriberFarms: ({ spec: acquired, analysisIds }) =>
                        extendFarmsForFlight({ storeRoot: root, spec: acquired, analysisIds, baseline }),
                },
                async () => {
                    await held.promise;
                    return provisionPackages({ storeRoot: root, specs: [spec.name] }, { run: runner, ensureImage: async () => ok(undefined) });
                },
                { pollMs: 5 },
            ),
        );
        await Promise.sleep(40);
        held.resolve();
        for (const flight of await Promise.all(flights)) expect(flight.isOk()).toBe(true);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual(["omega"]);
        for (const analysis of [first, second]) {
            const link = join(root, "farms", analysis.id, "python", "site-packages", "omega");
            expect(lstatSync(link).isSymbolicLink()).toBe(true);
            expect(readlinkSync(link)).toBe(`/mnt/libs/store/${OMEGA}/omega`);
            // The extension is additive: the closure of the template is still there.
            expect(lstatSync(join(root, "farms", analysis.id, "python", "site-packages", "beta")).isSymbolicLink()).toBe(true);
        }
    });

    test("a subscriber with no farm gets none, because composition is lazy", async () => {
        assertTestSandbox(env.locksDir);
        const root = composableStore();
        const analysis = seedAnalysis("chat only");

        await extendFarmsForFlight({
            storeRoot: root,
            spec: parseLibStoreFlightSpec("omega", "python")._unsafeUnwrap(),
            analysisIds: [analysis.id],
            baseline: new Set(),
        });

        // An analysis that started no sandbox owns no farm, and an extension must not make one.
        expect(existsSync(join(root, "farms", analysis.id))).toBe(false);
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
