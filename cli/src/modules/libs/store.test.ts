import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok } from "neverthrow";

import { runtimes, stream, type CaptureResult } from "../../lib/container.ts";
import { storePackagesFile } from "./packages.ts";
import {
    inspectStore,
    provisionPackages,
    reclaimPreview,
    reclaimStore,
    removeFarm,
    resolveActiveFarm,
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

afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
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

const SUCCESS: CaptureResult = { code: 0, stdout: "", stderr: "" };

describe("provisionPackages — the add path", () => {
    test("passes the farm and the new specs, and never a removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages({ storeRoot: root, image: "prov:local", farm: "default", specs: ["scanpy"] }, { run: runner });
        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.args).toEqual(["--farm", "default", "scanpy"]);
        expect(calls[0]!.network).toBe("online");
        for (const flag of ["--reclaim", "--remove-farm", "--repair"]) expect(calls[0]!.args).not.toContain(flag);
    });

    test("fails with guidance and starts no container when no provisioner image is configured", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await provisionPackages({ storeRoot: root, image: null, farm: "default", specs: ["scanpy"] }, { run: runner });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("image_unconfigured");
            expect(result.error.message).toContain("provisionerImage");
        }
        expect(calls).toHaveLength(0);
    });

    test("maps a store-lock conflict to an actionable message", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] another provisioning run holds the store lock; retry when it finishes\n" });
        const result = await provisionPackages({ storeRoot: root, image: "prov:local", farm: "default", specs: ["scanpy"] }, { run: runner });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
            expect(result.error.type).toBe("store_locked");
            expect(result.error.message.toLowerCase()).toContain("lock");
        }
    });

    test("surfaces any other non-zero exit as a provisioner failure", async () => {
        const root = tempStore();
        const { runner } = spyRunner({ code: 1, stdout: "", stderr: "[provision] uv could not resolve nonexistent-pkg\n" });
        const result = await provisionPackages({ storeRoot: root, image: "prov:local", farm: "default", specs: ["nonexistent-pkg"] }, { run: runner });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("provisioner_failed");
    });

    test("an observer that throws does not fail the run", async () => {
        const root = tempStore();
        const { runner } = spyRunner(SUCCESS);
        const result = await provisionPackages(
            { storeRoot: root, image: "prov:local", farm: "default", specs: ["scanpy"] },
            {
                run: runner,
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
        const result = await reclaimStore({ storeRoot: root, image: "prov:local" }, { run: runner });
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
        const { runner, calls } = spyRunner(SUCCESS);
        const result = await reclaimStore({ storeRoot: root, image: "prov:local" }, { run: runner });
        expect(result.isOk()).toBe(true);
        expect(calls).toHaveLength(0);
    });
});

describe("removeFarm", () => {
    test("passes --remove-farm offline and maps exit 2 to farm_not_found", async () => {
        const root = tempStore();
        const missing = spyRunner({ code: 2, stdout: "[provision] remove-farm: no such farm gone\n", stderr: "" });
        const result = await removeFarm({ storeRoot: root, image: "prov:local", farm: "gone" }, { run: missing.runner });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) expect(result.error.type).toBe("farm_not_found");
        expect(missing.calls[0]!.args).toEqual(["--remove-farm", "gone"]);
        expect(missing.calls[0]!.network).toBe("offline");
    });

    test("reports success on a clean exit", async () => {
        const root = tempStore();
        const { runner } = spyRunner(SUCCESS);
        const result = await removeFarm({ storeRoot: root, image: "prov:local", farm: "f1" }, { run: runner });
        expect(result.isOk()).toBe(true);
    });
});

describe("inspectStore — read-only", () => {
    test("reports packages, farms, and the active pointer", async () => {
        const root = tempStore();
        mkdirSync(join(root, "store", "scanpy-1.9-aaa"), { recursive: true });
        writeFileSync(join(root, "store", "scanpy-1.9-aaa", ".inflexa-pin"), "scanpy==1.9\n");
        mkdirSync(join(root, "farms", "default", "python", "site-packages"), { recursive: true });
        symlinkSync("../../../../store/scanpy-1.9-aaa", join(root, "farms", "default", "python", "site-packages", "scanpy"));
        symlinkSync("farms/default", join(root, "current"));

        const result = await inspectStore(root);
        expect(result.isOk()).toBe(true);
        if (result.isOk()) {
            expect(result.value.exists).toBe(true);
            expect(result.value.packages).toEqual([{ dir: "scanpy-1.9-aaa", pin: "scanpy==1.9" }]);
            const farm = result.value.farms.find((entry) => entry.name === "default");
            expect(farm?.active).toBe(true);
            expect(farm?.links).toBeGreaterThanOrEqual(1);
        }
    });

    test("reports an absent store as not present", async () => {
        const result = await inspectStore(join(tempStore(), "does-not-exist"));
        expect(result.isOk()).toBe(true);
        if (result.isOk()) expect(result.value.exists).toBe(false);
    });
});

// Invariant: no command other than reclaim and remove-farm removes store content. `inspectStore` and
// `reclaimPreview` take no container seam, so they can only read; the add path is checked to carry no
// removal flag, and the removal commands are the only ones that emit `--reclaim` / `--remove-farm`.
describe("only reclaim and remove-farm remove store content", () => {
    test("the add path never emits a removal flag", async () => {
        const root = tempStore();
        const { runner, calls } = spyRunner(SUCCESS);
        await provisionPackages({ storeRoot: root, image: "prov:local", farm: "default", specs: ["scanpy", "anndata"] }, { run: runner });
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
});

// Real provisioning: the tests above stub the container, so they prove the argument building and the
// exit-code classification only. This block drives the REAL provisioner against a throwaway store, so it
// proves the host half end to end — the store holds the distribution, the farm links it, and the active
// farm's inventory names it.
//
// The sandbox half — importing the package through the read-only mount at uid 1000 — is proven by
// scripts/lib-store-sandbox-checks.sh, and is not duplicated here.

/** The local provisioner image the store scripts build; the block skips when it is absent. */
const PROVISIONER_IMAGE = "inflexa-provisioner:local";

/**
 * True only when podman is installed and the provisioner image is present locally. A missing binary, a
 * stopped podman machine, or an absent image all read as "not present", so the block skips cleanly rather
 * than failing the suite. A synchronous inspect keeps the module-scope gate simple.
 */
function provisionerImagePresent(): boolean {
    if (!Bun.which(runtimes.podman.bin)) return false;
    try {
        return Bun.spawnSync({ cmd: [runtimes.podman.bin, "image", "inspect", PROVISIONER_IMAGE], stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    } catch {
        return false;
    }
}

const imagePresent = provisionerImagePresent();

/**
 * Run the real provisioner through podman. This mirrors the module's default runner but pins the engine:
 * routing through `ensureRuntime` could pick docker on a machine that has both, so a fixed engine keeps
 * the test deterministic and exercises the podman path the store scripts prove.
 */
const podmanRunner: ProvisionerRunner = async (invocation, onLine) => {
    const args = [
        "run",
        "--rm",
        ...(invocation.network === "offline" ? ["--network", "none"] : []),
        "-v",
        runtimes.podman.mountArg(invocation.storeRoot, "/mnt/libs"),
        invocation.image,
        ...invocation.args,
    ];
    return ok(await stream(runtimes.podman, args, onLine));
};

describe.skipIf(!imagePresent)("store add — the real provisioning path (podman + inflexa-provisioner:local)", () => {
    test("provisions six: the store holds it, the active farm links it, and that farm's packages.txt names it", async () => {
        const root = tempStore();
        // A first-run store has no `current` pointer, so the add extends the default farm.
        const farm = resolveActiveFarm(root);
        const result = await provisionPackages({ storeRoot: root, image: PROVISIONER_IMAGE, farm, specs: ["six"] }, { run: podmanRunner });

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
