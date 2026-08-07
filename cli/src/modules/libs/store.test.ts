import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok } from "neverthrow";

import { runtimes, stream, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { HARNESS_RUNTIME_LOCK_KEY, instanceLockPath, releaseInstanceLock } from "../../lib/lock.ts";
import { assertTestSandbox } from "../../test_support/sandbox.ts";
import { storePackagesFile } from "./packages.ts";
import {
    inspectStore,
    provisionPackages,
    reclaimPreview,
    reclaimStore,
    removeFarm,
    resolveActiveFarm,
    storeUse,
    type ProvisionerInvocation,
    type ProvisionerRunner,
} from "./store.ts";

// Each test builds an isolated store under tmpdir, never env.libStoreDir, so nothing touches real data.
// The container is always a stub: no test starts a real engine.
const created: string[] = [];

function tempStore(): string {
    const root = mkdtempSync(join(tmpdir(), "inflexa-store-"));
    created.push(root);
    return root;
}

// `storeUse` claims the machine-wide harness-runtime lock, which lives under env.locksDir. At the monorepo
// root that is the developer's REAL lock directory; refuse to run there rather than seed or delete a real
// lock file (data-loss guard — see test_support/sandbox.ts).
beforeEach(() => {
    assertTestSandbox(env.locksDir);
    rmSync(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY), { force: true });
});

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
    releaseInstanceLock(HARNESS_RUNTIME_LOCK_KEY);
    rmSync(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY), { force: true });
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

describe("provisionPackages — the add path", () => {
    test("passes the farm and the new specs, and never a removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, farm: "default", specs: ["scanpy"] },
            { run: runner, ensureImage: async () => ok(undefined) },
        );
        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual(["--farm", "default", "scanpy"]);
        expect(calls[0]!.network).toBe("online");
        expect(calls[0]!.image).toBe("ghcr.io/inflexa-ai/sandbox-provisioner:latest");
        for (const flag of ["--reclaim", "--remove-farm", "--repair"]) expect(calls[0]!.args).not.toContain(flag);
    });

    test("obtains the provisioner image before it starts the container, and never asks for a configured one", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const image = spyEnsureImage();
        const result = await provisionPackages({ storeRoot: root, farm: "default", specs: ["scanpy"] }, { run: runner, ensureImage: image.ensureImage });
        expect(result.isOk()).toBe(true);
        expect(image.calls).toBe(1);
        expect(calls).toHaveLength(1);
    });

    test("an image that cannot be obtained stops the command before the container starts", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, farm: "default", specs: ["scanpy"] },
            { run: runner, ensureImage: async () => err({ type: "image_unavailable" as const, message: "ghcr.io is unreachable" }) },
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("image_unavailable");
        expect(calls).toHaveLength(0);
    });

    test("maps a store-lock conflict to an actionable message", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] another provisioning run holds the store lock; retry when it finishes\n" });
        const result = await provisionPackages(
            { storeRoot: root, farm: "default", specs: ["scanpy"] },
            { run: runner, ensureImage: async () => ok(undefined) },
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("store_locked");
            expect(result.error.message.toLowerCase()).toContain("lock");
        }
    });

    test("surfaces any other non-zero exit as a provisioner failure", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] uv could not resolve nonexistent-pkg\n" });
        const result = await provisionPackages(
            { storeRoot: root, farm: "default", specs: ["nonexistent-pkg"] },
            { run: runner, ensureImage: async () => ok(undefined) },
        );
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("provisioner_failed");
    });

    test("an observer that throws does not fail the run", async () => {
        const root = tempStore();
        const { runner } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, farm: "default", specs: ["scanpy"] },
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

describe("resolveActiveFarm", () => {
    test("prefers an explicit farm", () => {
        expect(resolveActiveFarm(tempStore(), "mine")).toBe("mine");
    });

    test("falls back to the default when there is no active farm", () => {
        expect(resolveActiveFarm(tempStore())).toBe("default");
    });

    test("reads the farm the `current` pointer selects", () => {
        const root = tempStore();
        mkdirSync(join(root, "farms", "analysis-x"), { recursive: true });
        symlinkSync("farms/analysis-x", join(root, "current"));
        expect(resolveActiveFarm(root)).toBe("analysis-x");
    });
});

describe("reclaim — preview then remove", () => {
    test("previews unreferenced packages and runs --reclaim offline", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        mkdirSync(join(root, "store", "bar-2.0-bbb"), { recursive: true });
        mkdirSync(join(root, "farms", "f1", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/foo-1.0-aaa", join(root, "farms", "f1", "python", "site-packages", "foo"));

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
        mkdirSync(join(root, "farms", "f1", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/foo-1.0-aaa", join(root, "farms", "f1", "python", "site-packages", "foo"));
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
    test("reports packages, farms, and the active pointer", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "scanpy-1.9-aaa"), { recursive: true });
        writeFileSync(join(root, "store", "scanpy-1.9-aaa", ".inflexa-pin"), "scanpy==1.9\n");
        makeFarm(root, "default");
        mkdirSync(join(root, "farms", "default", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/scanpy-1.9-aaa", join(root, "farms", "default", "python", "site-packages", "scanpy"));
        symlinkSync("farms/default", join(root, "current"));

        const result = await inspectStore(root);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value.exists).toBe(true);
            expect(result.value.active).toEqual({ state: "resolved", farm: "default" });
            expect(result.value.packages).toEqual([{ dir: "scanpy-1.9-aaa", pin: "scanpy==1.9" }]);
            const farm = result.value.farms.find((entry) => entry.name === "default");
            expect(farm?.active).toBe(true);
            expect(farm?.links).toBeGreaterThanOrEqual(1);
        }
    });

    test("reports a pointer that resolves to nothing, so the user can see the state that breaks every sandbox", async () => {
        const root = tempStore();
        makeFarm(root, "catalog");
        symlinkSync("farms/gone", join(root, "current"));

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.active).toEqual({ state: "dangling", farm: "gone" });
        // No farm claims to be active while the pointer resolves to nothing.
        expect(inspection.farms.every((farm) => !farm.active)).toBe(true);
    });

    test("reports an absent pointer as absent, not as a farm", async () => {
        const root = tempStore();
        makeFarm(root, "catalog");
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.active).toEqual({ state: "absent" });
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

    test("reports an absent store as not present", async () => {
        const result = await inspectStore(join(tempStore(), "does-not-exist"));
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.exists).toBe(false);
    });
});

describe("storeUse — the atomic switch of the active farm", () => {
    /** The farm name `current` selects, or null when there is no pointer. */
    function pointerTarget(root: string): string | null {
        try {
            return readlinkSync(join(root, "current"));
        } catch {
            return null;
        }
    }

    test("switches the active farm and reports the one it replaced", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        symlinkSync("farms/default", join(root, "current"));

        const result = await storeUse({ storeRoot: root, farm: "catalog" });
        expect(result._unsafeUnwrap()).toEqual({ farm: "catalog", previous: "default" });
        expect(pointerTarget(root)).toBe("farms/catalog");
    });

    // The pointer must resolve at EVERY moment, because a sandbox created while it is absent silently
    // drops the store mount. The write is a rename over the existing name, which is atomic within one
    // filesystem — so there is no window to observe rather than a window this test must catch. Two facts
    // pin it: the switch succeeds over a pointer that is already there (an unlink-free `symlink` onto an
    // existing name would fail with EEXIST), and the temporary name it built the link at is gone.
    test("replaces an existing pointer by rename, and leaves no temporary link behind", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        symlinkSync("farms/default", join(root, "current"));
        expect(pointerTarget(root)).toBe("farms/default");

        expect((await storeUse({ storeRoot: root, farm: "catalog" })).isOk()).toBe(true);

        expect(pointerTarget(root)).toBe("farms/catalog");
        expect(existsSync(join(root, "farms", "catalog"))).toBe(true);
        expect(readdirSync(root).filter((name) => name.startsWith(".current"))).toEqual([]);
    });

    test("sets the pointer on a store that carried none", async () => {
        const root = tempStore();
        makeFarm(root, "catalog");
        const result = await storeUse({ storeRoot: root, farm: "catalog" });
        expect(result._unsafeUnwrap()).toEqual({ farm: "catalog", previous: null });
        expect(pointerTarget(root)).toBe("farms/catalog");
    });

    test("refuses a farm that is not there, and leaves the pointer unchanged", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        symlinkSync("farms/default", join(root, "current"));

        const result = await storeUse({ storeRoot: root, farm: "nope" });
        expect(result._unsafeUnwrapErr().type).toBe("farm_not_found");
        expect(pointerTarget(root)).toBe("farms/default");
    });

    test("refuses a farm the harness would not mount, naming the records it lacks", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        symlinkSync("farms/default", join(root, "current"));
        mkdirSync(join(root, "farms", "half"), { recursive: true });
        writeFileSync(join(root, "farms", "half", "packages.txt"), "scanpy 1.9\n");

        const error = (await storeUse({ storeRoot: root, farm: "half" }))._unsafeUnwrapErr();
        expect(error.type).toBe("farm_incomplete");
        if (error.type === "farm_incomplete") expect(error.missing).toEqual(["meta.json"]);
        expect(pointerTarget(root)).toBe("farms/default");
    });

    test("refuses a dot-prefixed name, which marks staging or superseded debris", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        symlinkSync("farms/default", join(root, "current"));
        makeFarm(root, ".catalog-staging");

        const error = (await storeUse({ storeRoot: root, farm: ".catalog-staging" }))._unsafeUnwrapErr();
        expect(error.type).toBe("reserved_name");
        expect(error.message).toContain("staging");
        expect(pointerTarget(root)).toBe("farms/default");
    });

    test("refuses while a download is in flight, and leaves the pointer unchanged", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        symlinkSync("farms/default", join(root, "current"));
        // A staging directory is the fingerprint `inspectLibStoreDownload` reads as `incomplete`.
        mkdirSync(join(root, ".inflexa-download", "staging"), { recursive: true });

        const error = (await storeUse({ storeRoot: root, farm: "catalog" }))._unsafeUnwrapErr();
        expect(error.type).toBe("download_in_flight");
        expect(pointerTarget(root)).toBe("farms/default");
    });

    test("refuses while the harness runtime holds the machine-wide lock", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        symlinkSync("farms/default", join(root, "current"));
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(dirname(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY)), { recursive: true });
        writeFileSync(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY), String(holder.pid));

        try {
            const error = (await storeUse({ storeRoot: root, farm: "catalog" }))._unsafeUnwrapErr();
            expect(error.type).toBe("runtime_live");
            if (error.type === "runtime_live") expect(error.holderPid).toBe(holder.pid);
            expect(error.message).toContain("--force");
            expect(pointerTarget(root)).toBe("farms/default");
        } finally {
            holder.kill();
            await holder.exited;
        }
    });

    test("`--force` switches under a held lock, and it names the risk BEFORE the pointer moves", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        symlinkSync("farms/default", join(root, "current"));
        const holder = Bun.spawn(["sleep", "60"]);
        mkdirSync(dirname(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY)), { recursive: true });
        writeFileSync(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY), String(holder.pid));

        try {
            // Recording the pointer AT notice time is what proves the ordering: the risk is named while
            // the old farm is still selected, not reported after the fact.
            const notices: { line: string; pointerThen: string | null }[] = [];
            const result = await storeUse(
                { storeRoot: root, farm: "catalog", force: true },
                { onNotice: (line) => notices.push({ line, pointerThen: pointerTarget(root) }) },
            );
            expect(result._unsafeUnwrap().farm).toBe("catalog");
            expect(notices).toHaveLength(1);
            expect(notices[0]!.line).toContain("live sandbox");
            expect(notices[0]!.pointerThen).toBe("farms/default");
            expect(pointerTarget(root)).toBe("farms/catalog");
        } finally {
            holder.kill();
            await holder.exited;
        }
    });

    test("`--force` bypasses the live runtime and NOTHING else", async () => {
        const root = tempStore();
        makeFarm(root, "default");
        symlinkSync("farms/default", join(root, "current"));
        mkdirSync(join(root, "farms", "half"), { recursive: true });
        writeFileSync(join(root, "farms", "half", "packages.txt"), "scanpy 1.9\n");
        makeFarm(root, ".debris");

        // An absent farm, an incomplete farm, and a dot-prefixed name each still refuse.
        expect((await storeUse({ storeRoot: root, farm: "nope", force: true }))._unsafeUnwrapErr().type).toBe("farm_not_found");
        expect((await storeUse({ storeRoot: root, farm: "half", force: true }))._unsafeUnwrapErr().type).toBe("farm_incomplete");
        expect((await storeUse({ storeRoot: root, farm: ".debris", force: true }))._unsafeUnwrapErr().type).toBe("reserved_name");
        expect(pointerTarget(root)).toBe("farms/default");

        // And so does an in-flight download.
        makeFarm(root, "catalog");
        mkdirSync(join(root, ".inflexa-download", "staging"), { recursive: true });
        expect((await storeUse({ storeRoot: root, farm: "catalog", force: true }))._unsafeUnwrapErr().type).toBe("download_in_flight");
        expect(pointerTarget(root)).toBe("farms/default");
    });

    test("a switch releases the runtime lock it took, so a later boot is not wedged", async () => {
        const root = tempStore();
        makeFarm(root, "catalog");
        expect((await storeUse({ storeRoot: root, farm: "catalog" })).isOk()).toBe(true);
        expect(existsSync(instanceLockPath(HARNESS_RUNTIME_LOCK_KEY))).toBe(false);
    });
});

// Invariant: no command other than reclaim and remove-farm removes store content. `inspectStore`,
// `reclaimPreview`, and `storeUse` take no container seam, so they can only read or move the pointer; the
// add path is checked to carry no removal flag, and the removal commands are the only ones that emit
// `--reclaim` / `--remove-farm`.
describe("only reclaim and remove-farm remove store content", () => {
    test("the add path never emits a removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        await provisionPackages({ storeRoot: root, farm: "default", specs: ["scanpy", "anndata"] }, { run: runner, ensureImage: async () => ok(undefined) });
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

    test("the switch keeps every farm and every package", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "foo-1.0-aaa"), { recursive: true });
        makeFarm(root, "default");
        makeFarm(root, "catalog");
        expect((await storeUse({ storeRoot: root, farm: "catalog" })).isOk()).toBe(true);
        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.farms.map((farm) => farm.name)).toEqual(["catalog", "default"]);
        expect(inspection.packages.map((pkg) => pkg.dir)).toEqual(["foo-1.0-aaa"]);
    });
});

// Real provisioning: the tests above stub the container, so they prove the argument building and the
// exit-code classification only. This block drives the REAL provisioner against a throwaway store, so it
// proves the host half end to end — the store holds the distribution, the farm links it, and the active
// farm's inventory names it.
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

describe.skipIf(!imagePresent)("store add — the real provisioning path (podman + inflexa-provisioner:local)", () => {
    test("provisions six: the store holds it, the active farm links it, and that farm's packages.txt names it", async () => {
        const root = tempStore();
        // A first-run store has no `current` pointer, so the add extends the default farm.
        const farm = resolveActiveFarm(root);
        // The image is already present, so the real ensure step would be a no-op; stub it so the test
        // never reaches a registry.
        const result = await provisionPackages({ storeRoot: root, farm, specs: ["six"] }, { run: podmanRunner, ensureImage: async () => ok(undefined) });

        // An Err here is a real provisioning failure — the message carries the provisioner's tail.
        const outcome = result._unsafeUnwrap();
        expect(outcome.farm).toBe(farm);

        const inspection = (await inspectStore(root))._unsafeUnwrap();
        expect(inspection.exists).toBe(true);
        // The store holds the distribution as a content-addressed directory.
        expect(inspection.packages.some((pkg) => pkg.dir.startsWith("six-"))).toBe(true);
        // The farm the add extended is the active one, and it links at least the one distribution.
        const active = inspection.farms.find((entry) => entry.name === farm);
        expect(active?.active).toBe(true);
        expect(active?.links).toBeGreaterThanOrEqual(1);

        // The inventory the sandbox reads follows the active `current` pointer and names the package.
        const inventory = storePackagesFile(root);
        expect(inventory).not.toBeNull();
        expect(readFileSync(inventory!, "utf8")).toContain("six");
    }, 180_000);
});
