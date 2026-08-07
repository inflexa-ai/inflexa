/**
 * The `inflexa store` command actions — add, ls, use, remove-farm, reclaim — over the host package store.
 *
 * The store is a host directory the harness bind-mounts read-only at `/mnt/libs` for EVERY sandbox. Its
 * root is `env.libStoreDir`, a CLI-owned path: these commands write exactly where boot reads, and no
 * config value moves either side. The store is not optional. The runtime image bakes no R library and no
 * Python library, so a sandbox with no store mounted can import nothing.
 *
 * The store holds one content-addressed `store/` pool, per-farm symlink trees under `farms/`, and the
 * `current` symlink that selects the active farm. A sandbox mounts whatever `current` resolves to.
 *
 * The provisioner container starts ONLY for an operation that installs packages or mutates the store
 * under the store lock. It is the one container with network access and a compiler, and it owns the
 * per-store lock, so `add`, `reclaim`, and `remove-farm` start it through `lib/container.ts` — the same
 * engine wrapper the image pull uses, so engine selection and socket resolution are not duplicated.
 *
 * The other operations are host filesystem work and start NO container: the read of the active farm, the
 * list of what the store holds, the reclaim preview, and the switch of the active farm. The provisioner
 * image is measured in gigabytes, so a container start is a real cost that a read or a pointer move must
 * not pay.
 *
 * The provisioner image reference is the {@link PROVISIONER_IMAGE} constant. No configuration value names
 * it and none can move it: the provisioner offers no variant, so a user chooses nothing. A command that
 * must start the container obtains the image when the machine does not hold it, rather than refusing.
 *
 * `store use` SWITCHES the active farm and it never merges two farms. A link-level union is unsafe: the
 * provisioner keeps the first link on a collision, so a union of two farms that pin different versions of
 * one distribution would give an environment that no resolver validated, and a lock file that describes
 * neither input. There is deliberately no merge option.
 */

import { existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { lstat, readFile, readdir, readlink, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";

import { ensureRuntime } from "../../lib/config.ts";
import { stream, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock, HARNESS_RUNTIME_LOCK_KEY } from "../../lib/lock.ts";
import { PROVISIONER_IMAGE } from "./images.ts";
import { ensureProvisionerImage } from "./pull.ts";
import {
    cancelLibStoreDownload,
    inspectLibStoreDownload,
    installedLibStoreManifest,
    readLibStoreDownloadReport,
    runLibStoreTransfer,
    startLibStoreDownloadProcess,
    type LibStoreDownloadStatus,
} from "./store_download.ts";

/** The path the store is mounted at in both the provisioner (read-write) and the sandbox (read-only). */
const LIB_MOUNT = "/mnt/libs";

/**
 * The farm a bare `store add` extends when the store has no active one and the user names none. The store
 * is per-installation today (one `current` pointer), so a single default farm is the whole surface until
 * the per-analysis mount work lands.
 */
const DEFAULT_FARM = "default";

/** The pin marker the provisioner writes inside each store directory, recording its `name==version`. */
const PIN_MARKER = ".inflexa-pin";

/** The package inventory a complete farm carries. The harness mount check requires it, and so does `store use`. */
const FARM_INVENTORY = "packages.txt";

/** The store metadata a complete farm carries, recording its version, its architecture, and its tracks. */
const FARM_METADATA = "meta.json";

/**
 * The message the provisioner prints when a second run finds the store lock held. Matched so the CLI turns
 * a normal condition — two terminals — into an actionable message instead of a bare non-zero exit.
 */
const STORE_LOCK_PATTERN = /holds the store lock/;

/** Why a store-management action could not complete. Each variant maps to one actionable user message. */
export type ProvisionError =
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "image_unavailable"; readonly message: string }
    | { readonly type: "store_locked"; readonly message: string }
    | { readonly type: "download_in_flight"; readonly message: string }
    | { readonly type: "farm_not_found"; readonly farm: string; readonly message: string }
    | { readonly type: "provisioner_failed"; readonly code: number; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause: unknown };

/** A single progress line from the provisioner container, delivered to an observer as it lands. */
export type ProvisionProgress = { readonly type: "log"; readonly line: string };

/**
 * Caller-supplied hooks for a store-management action. `run` is the container seam — injected so a test
 * exercises the argument building and exit-code classification without a real engine. `ensureImage` is
 * the image seam, for the same reason. `onProgress` is a notification channel over the provisioner's live
 * output; it CANNOT fail the action, because a readout is decoration over work that is otherwise
 * succeeding (the reference-store installer's observer contract).
 */
export type ProvisionDeps = {
    readonly run?: ProvisionerRunner;
    readonly ensureImage?: () => Promise<Result<void, ProvisionError>>;
    readonly onProgress?: (event: ProvisionProgress) => void;
};

/** What the provisioner container is asked to do: the image, the store to mount, the network, and its arguments. */
export type ProvisionerInvocation = {
    readonly image: string;
    readonly storeRoot: string;
    /** `online` for provisioning (it reaches the package index); `offline` for reclaim and farm removal, which touch only local disk. */
    readonly network: "online" | "offline";
    /** The arguments passed to the provisioner entry point (for example `--farm default scanpy`, `--reclaim`, `--remove-farm x`). */
    readonly args: readonly string[];
};

/** No container engine was available to start the provisioner. */
export type RuntimeUnavailableError = { readonly type: "runtime_unavailable"; readonly message: string };

/**
 * How the provisioner container is started. The default resolves and pins a container runtime, then
 * streams the provisioner through `lib/container.ts`. Injected so a test drives the command logic against
 * a fake, and so no test ever starts a real container.
 */
export type ProvisionerRunner = (invocation: ProvisionerInvocation, onLine: (line: string) => void) => Promise<Result<CaptureResult, RuntimeUnavailableError>>;

/** A completed provisioning run. */
export type ProvisionOutcome = { readonly farm: string; readonly specs: readonly string[] };

/** A completed reclamation run, carrying the store directories it removed. */
export type ReclaimOutcome = { readonly reclaimed: readonly string[] };

/** One stored distribution, by its store directory name and the pin it records (`name==version`, or `null` when the marker is absent). */
export type StorePackage = { readonly dir: string; readonly pin: string | null };

/** One farm: its name, whether `current` selects it, how many symlinks it holds, and the tracks it carries. */
export type StoreFarm = {
    readonly name: string;
    readonly active: boolean;
    readonly links: number;
    /**
     * The track names the farm's `meta.json` records, for example `python` and `r`. Empty when the file
     * records none or cannot be read. A farm with fewer tracks than another is the reason an import fails
     * after a switch, so the inspection reports it.
     */
    readonly tracks: readonly string[];
};

/**
 * The state of the active-farm pointer, which decides what every sandbox mounts.
 *
 * `dangling` is its own state and not an absence: the pointer names a farm, and the farm is gone. It
 * makes every sandbox unusable, and the user cannot see it from the farm list alone.
 */
export type ActiveFarmPointer =
    { readonly state: "absent" } | { readonly state: "dangling"; readonly farm: string } | { readonly state: "resolved"; readonly farm: string };

/**
 * What the inspection reports about the detached catalog download.
 *
 * The state is the one a reader acts on, which is the row corrected by the liveness of the lock: a
 * `running` row whose holder is gone reads as `failed`. `null` means that no download ever ran, which is
 * a normal condition — a store root can arrive by a manual pull or by `inflexa store add`.
 */
export type StoreDownloadInspection = {
    /** The lifecycle state, or `null` when no download ran. */
    readonly state: LibStoreDownloadStatus | null;
    /** The bytes the transfer has moved. */
    readonly bytesTransferred: number;
    /** The bytes the manifest declares, or `null` before the manifest resolves. */
    readonly totalBytes: number | null;
    /** The user-facing message of a failure. */
    readonly message: string | null;
    /** True when the receipt pins a manifest that is not the one the last resolve saw. */
    readonly updateAvailable: boolean;
};

/** A passive inspection of the store, read from the host filesystem. */
export type StoreInspection = {
    readonly root: string;
    readonly exists: boolean;
    /** What the active-farm pointer selects. */
    readonly active: ActiveFarmPointer;
    readonly packages: readonly StorePackage[];
    readonly farms: readonly StoreFarm[];
    /** Bytes the deduplicated store content occupies (`store/` only — the farms are symlinks). */
    readonly storeBytes: number;
    /** The state of the catalog download. It describes the process, and it decides nothing about usability. */
    readonly download: StoreDownloadInspection;
};

/** Deliver one progress event, swallowing anything the observer throws so it can never fail the run. */
function reportProgress(deps: ProvisionDeps, event: ProvisionProgress): void {
    try {
        deps.onProgress?.(event);
    } catch {
        // Intentionally empty: a progress readout is decoration over work that is otherwise succeeding.
    }
}

/**
 * The default image seam: obtain the provisioner image when the machine does not hold it.
 *
 * The command that reaches this is already approval-gated and the user asked for it, so the pull needs no
 * second consent. An absent image is never reported as an unconfigured one, because nothing configures it.
 */
const defaultEnsureImage = async (): Promise<Result<void, ProvisionError>> => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    return (await ensureProvisionerImage(rtResult.value)).mapErr((e) => ({ type: "image_unavailable", message: e.message }));
};

/** The default runner: resolve and pin a container runtime, then stream the provisioner through `lib/container.ts`. */
const defaultRunner: ProvisionerRunner = async (invocation, onLine) => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    // The store mounts read-write here — the sandbox mounts the same root read-only — because the
    // provisioner writes packages and farms into it. `mountArg` already yields a read-write bind for both
    // engines (Podman's `:z` adds a shared SELinux relabel, never a read-only flag). Provisioning needs the
    // network to reach the package index; reclaim and farm removal touch only local disk, so they run with
    // no network at all.
    const args = [
        "run",
        "--rm",
        ...(invocation.network === "offline" ? ["--network", "none"] : []),
        "-v",
        rt.mountArg(invocation.storeRoot, LIB_MOUNT),
        invocation.image,
        ...invocation.args,
    ];
    try {
        return ok(await stream(rt, args, onLine));
    } catch (cause) {
        // The runtime was ready a moment ago, so a spawn failure now means it became unavailable.
        return err({ type: "runtime_unavailable", message: `Could not start the provisioner with ${rt.label}: ${errorText(cause)}` });
    }
};

/** Turn a completed container run into a Result, mapping a store-lock conflict to its own actionable error. */
function classifyRun(res: CaptureResult): Result<void, ProvisionError> {
    if (res.code === 0) return ok(undefined);
    const combined = `${res.stdout}\n${res.stderr}`;
    if (res.code === 1 && STORE_LOCK_PATTERN.test(combined)) {
        return err({
            type: "store_locked",
            message: "Another provisioning run holds the package-store lock. Wait for it to finish, then run this command again.",
        });
    }
    return err({ type: "provisioner_failed", code: res.code, message: `The provisioner exited with code ${res.code}.\n${provisionerTail(combined)}` });
}

/**
 * The farm a bare `store add` extends: the explicit `--farm`, else the farm `current` selects, else
 * {@link DEFAULT_FARM}. Reading `current` is a passive host lookup; a missing or dangling pointer means
 * there is no active farm, which is the normal first-run state, not an error.
 */
export function resolveActiveFarm(storeRoot: string, explicit?: string): string {
    if (explicit !== undefined && explicit.trim() !== "") return explicit.trim();
    return readCurrentTarget(storeRoot) ?? DEFAULT_FARM;
}

/** The farm name `current` points at (`farms/<name>`), or `null` when there is no usable pointer. */
function readCurrentTarget(storeRoot: string): string | null {
    try {
        const name = basename(readlinkSync(join(storeRoot, "current")));
        return name === "" ? null : name;
    } catch {
        return null;
    }
}

/** What the active-farm pointer selects: nothing, a farm that is gone, or a farm that is there. */
function readActiveFarmPointer(storeRoot: string): ActiveFarmPointer {
    const farm = readCurrentTarget(storeRoot);
    if (farm === null) return { state: "absent" };
    return existsSync(join(storeRoot, "farms", farm)) ? { state: "resolved", farm } : { state: "dangling", farm };
}

/**
 * Provision packages into a farm, extending its closure. The provisioner unions the new specs with the
 * farm's earlier requests, so this passes only the new specs and the harness re-resolves the whole set —
 * an add is additive by design.
 */
export async function provisionPackages(
    params: { readonly storeRoot: string; readonly farm: string; readonly specs: readonly string[] },
    deps: ProvisionDeps = {},
): Promise<Result<ProvisionOutcome, ProvisionError>> {
    // A live download merges its staged tree into the store root ONE CHILD AT A TIME, so a provisioning
    // run that writes into the same pool during that merge can meet a half-merged root. The refusal covers
    // the whole live period, exactly as `storeUse` refuses. A row of `running` whose holder is gone reads
    // as failed, thus a dead downloader refuses nothing.
    const download = readLibStoreDownloadReport();
    if (download.live) {
        return err({
            type: "download_in_flight",
            message:
                "A package-store download is in flight, and it merges into this same store root. Wait for it to finish, or run `inflexa store cancel` to stop it. Run `inflexa store ls` to see its progress.",
        });
    }

    // The bind-mount source must exist before the engine mounts it; a missing source would be
    // auto-created as a root-owned directory the user cannot manage.
    const ensured = ensureStoreRootExists(params.storeRoot);
    if (ensured.isErr()) return err(ensured.error);
    const image = await (deps.ensureImage ?? defaultEnsureImage)();
    if (image.isErr()) return err(image.error);
    const run = deps.run ?? defaultRunner;
    const ran = await run(
        { image: PROVISIONER_IMAGE, storeRoot: params.storeRoot, network: "online", args: ["--farm", params.farm, ...params.specs] },
        (line) => reportProgress(deps, { type: "log", line }),
    );
    if (ran.isErr()) return err(ran.error);
    return classifyRun(ran.value).map(() => ({ farm: params.farm, specs: params.specs }));
}

/** Remove a farm's symlinks. The store directories it referenced stay until reclaim runs. */
export async function removeFarm(
    params: { readonly storeRoot: string; readonly farm: string },
    deps: ProvisionDeps = {},
): Promise<Result<void, ProvisionError>> {
    const image = await (deps.ensureImage ?? defaultEnsureImage)();
    if (image.isErr()) return err(image.error);
    const run = deps.run ?? defaultRunner;
    const ran = await run({ image: PROVISIONER_IMAGE, storeRoot: params.storeRoot, network: "offline", args: ["--remove-farm", params.farm] }, (line) =>
        reportProgress(deps, { type: "log", line }),
    );
    if (ran.isErr()) return err(ran.error);
    // The provisioner exits 2 when no farm by that name exists — a clean not-found, not a fault.
    if (ran.value.code === 2) return err({ type: "farm_not_found", farm: params.farm, message: `No farm named "${params.farm}" in the package store.` });
    return classifyRun(ran.value);
}

/**
 * The store directories no farm references — the set reclamation would remove. Computed on the host so a
 * command can report it before removing anything. This mirrors the provisioner's own referenced-set scan,
 * so the preview and the removal agree unless a concurrent run changes the store between them.
 */
export async function reclaimPreview(storeRoot: string): Promise<Result<readonly string[], ProvisionError>> {
    try {
        const storeDir = join(storeRoot, "store");
        if (!existsSync(storeDir)) return ok([]);
        const referenced = await referencedStoreDirs(storeRoot);
        const entries = await readdir(storeDir, { withFileTypes: true });
        const unreferenced = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .filter((name) => !referenced.has(name))
            .sort((a, b) => a.localeCompare(b));
        return ok(unreferenced);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
    }
}

/**
 * Remove store content no farm references, holding the store lock through the provisioner so a concurrent
 * add cannot race the delete. Runs the container only when there is something to remove, so a clean store
 * costs no engine start. The caller reports {@link reclaimPreview} before this runs, so the removal is
 * never a surprise.
 */
export async function reclaimStore(params: { readonly storeRoot: string }, deps: ProvisionDeps = {}): Promise<Result<ReclaimOutcome, ProvisionError>> {
    const preview = await reclaimPreview(params.storeRoot);
    if (preview.isErr()) return err(preview.error);
    const candidates = preview.value;
    if (candidates.length === 0) return ok({ reclaimed: [] });
    const image = await (deps.ensureImage ?? defaultEnsureImage)();
    if (image.isErr()) return err(image.error);
    const run = deps.run ?? defaultRunner;
    const ran = await run({ image: PROVISIONER_IMAGE, storeRoot: params.storeRoot, network: "offline", args: ["--reclaim"] }, (line) =>
        reportProgress(deps, { type: "log", line }),
    );
    if (ran.isErr()) return err(ran.error);
    return classifyRun(ran.value).map(() => ({ reclaimed: candidates }));
}

/**
 * Inspect the store from the host filesystem: the active-farm pointer, its packages, its farms with their
 * tracks, and the disk the content occupies. Read-only by construction — it takes no container seam, so no
 * command routed through it can remove content. An absent root is a normal state, reported as
 * `exists: false`, not an error.
 */
export async function inspectStore(storeRoot: string): Promise<Result<StoreInspection, ProvisionError>> {
    try {
        const download = await inspectStoreDownload(storeRoot);
        if (!existsSync(storeRoot)) {
            return ok({ root: storeRoot, exists: false, active: { state: "absent" }, packages: [], farms: [], storeBytes: 0, download });
        }
        const active = readActiveFarmPointer(storeRoot);
        const packages = await readStorePackages(storeRoot);
        const farms = await readFarms(storeRoot, active);
        const storeBytes = await dirBytes(join(storeRoot, "store"));
        return ok({ root: storeRoot, exists: true, active, packages, farms, storeBytes, download });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
    }
}

/**
 * The download half of the inspection: the lifecycle row, corrected for a dead holder, plus the update
 * comparison.
 *
 * An update is available when the receipt pins one manifest and the last resolve saw a different one.
 * Both halves are local, thus the listing needs no network and it opens no prompt — the user owns the
 * decision, and `inflexa store download --update` is the consent that applies it.
 */
async function inspectStoreDownload(storeRoot: string): Promise<StoreDownloadInspection> {
    const report = readLibStoreDownloadReport();
    const latest = report.row?.manifestDigest ?? null;
    const installed = latest === null ? null : await installedLibStoreManifest(storeRoot);
    return {
        state: report.state,
        bytesTransferred: report.row?.bytesTransferred ?? 0,
        totalBytes: report.row?.totalBytes ?? null,
        message: report.row?.message ?? null,
        updateAvailable: installed !== null && latest !== null && installed !== latest,
    };
}

// --- the active-farm switch ---------------------------------------------------

/** Why `inflexa store use` refused. Each variant maps to one actionable user message. */
export type StoreUseError =
    | { readonly type: "runtime_live"; readonly holderPid: number; readonly message: string }
    | { readonly type: "download_in_flight"; readonly message: string }
    | { readonly type: "farm_not_found"; readonly farm: string; readonly message: string }
    | { readonly type: "farm_incomplete"; readonly farm: string; readonly missing: readonly string[]; readonly message: string }
    | { readonly type: "reserved_name"; readonly farm: string; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause: unknown };

/** A completed switch: the farm now active, and the one it replaced (`null` when there was no pointer). */
export type StoreUseOutcome = { readonly farm: string; readonly previous: string | null };

/** Caller-supplied hooks for {@link storeUse}. */
export type StoreUseDeps = {
    /** Report one line to the user. The forced switch names its risk through this, BEFORE the write. */
    readonly onNotice?: (line: string) => void;
};

/** The risk a forced switch takes, named before the pointer moves. */
const FORCE_RISK_NOTICE =
    "A live sandbox keeps its own resolved mount of /mnt/libs/current. This switch re-points it, and that sandbox then reads nothing from the store.";

/**
 * Switch the active farm of the store, atomically and with no container.
 *
 * The write makes the new link at a temporary name in the store root, then renames that name over
 * `current`. A rename over an existing name is atomic within one filesystem, and the store root is one
 * filesystem. The pointer therefore resolves at every moment: it names the old farm, then the new one, and
 * it is never absent. That matters because the harness refuses a store whose `current` does not resolve
 * and then drops the mount with a warning only, so a sandbox created inside an unlink-then-relink window
 * would hold no package and report nothing.
 *
 * It refuses, and leaves the pointer untouched, in five cases. `force` bypasses the live-runtime refusal
 * and NOTHING else: the other four protect the pointer itself, and a forced pointer that no sandbox can
 * mount would trade a clear refusal for a store the harness rejects at every later sandbox.
 */
export async function storeUse(
    params: { readonly storeRoot: string; readonly farm: string; readonly force?: boolean },
    deps: StoreUseDeps = {},
): Promise<Result<StoreUseOutcome, StoreUseError>> {
    const farm = params.farm.trim();
    // A dot name marks staging debris or a farm a swap superseded, never a farm to select. Checked first
    // because it is a fact about the name alone, so it costs no disk read.
    if (farm.startsWith(".")) {
        return err({
            type: "reserved_name",
            farm,
            message: `"${farm}" is a dot-prefixed name, which marks staging or superseded debris rather than a farm. Run \`inflexa store ls\` to see the farms.`,
        });
    }

    const farmPath = join(params.storeRoot, "farms", farm);
    let missing: readonly string[];
    try {
        if (!existsSync(farmPath) || !(await stat(farmPath)).isDirectory()) {
            return err({
                type: "farm_not_found",
                farm,
                message: `No farm named "${farm}" under ${join(params.storeRoot, "farms")}. Run \`inflexa store ls\` to see the farms.`,
            });
        }
        // The shape the harness mount check requires. The CLI applies it HERE, and nowhere else, because
        // the refusal is the point of this command: a refusal before the write beats a broken pointer.
        missing = [FARM_INVENTORY, FARM_METADATA].filter((name) => !existsSync(join(farmPath, name)));
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not read the farm at ${farmPath}.`, cause });
    }
    if (missing.length > 0) {
        return err({
            type: "farm_incomplete",
            farm,
            missing,
            message: `The farm "${farm}" carries no ${missing.join(" and no ")}, so the harness would refuse to mount it. Run \`inflexa store add\` to build it, or select a complete farm.`,
        });
    }

    // A download merges its staged tree into the store root, so it can add a farm while this switch runs.
    // The two must not overlap.
    if ((await inspectLibStoreDownload(params.storeRoot)) === "incomplete") {
        return err({
            type: "download_in_flight",
            message:
                "A package-store download is in flight or was interrupted. Wait for it to finish, or open `inflexa` to repair it, then run this command again.",
        });
    }

    // A sandbox can exist only under a live harness runtime, and that runtime holds the machine-wide
    // instance lock for its whole life. The held lock is therefore a sound "a sandbox may be live" guard,
    // and it needs no per-sandbox lease. `acquireInstanceLock` reclaims a lock whose holder pid is dead,
    // so `force` covers only the case that survives that check.
    const lock = acquireInstanceLock(HARNESS_RUNTIME_LOCK_KEY);
    if (!lock.acquired && params.force !== true) {
        return err({
            type: "runtime_live",
            holderPid: lock.holderPid,
            message: `Another \`inflexa\` process (pid ${lock.holderPid}) is running the harness runtime, and a switch re-points the store under any sandbox it holds. Stop that process, or pass \`--force\` to switch anyway.`,
        });
    }
    // Naming the risk is what `--force` buys the user: they asked to bypass the guard, so say what the
    // guard protects before the pointer moves, not after.
    if (params.force === true) deps.onNotice?.(FORCE_RISK_NOTICE);

    try {
        const previous = readCurrentTarget(params.storeRoot);
        const link = join(params.storeRoot, "current");
        // A dot name for the temporary link, so a concurrent walk of the store root skips it exactly as it
        // skips staging debris. The uuid keeps two switches from choosing the same name.
        const temp = join(params.storeRoot, `.current-${randomUUIDv7()}`);
        // Relative, matching what the provisioner writes: the link is read inside the container at
        // /mnt/libs/current, where an absolute host path would resolve to nothing.
        symlinkSync(`farms/${farm}`, temp);
        try {
            renameSync(temp, link);
        } catch (cause) {
            rmSync(temp, { force: true });
            throw cause;
        }
        return ok({ farm, previous });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not point the active farm at "${farm}" in ${params.storeRoot}.`, cause });
    } finally {
        // Release only a lock this call took. `releaseInstanceLock` checks the holder pid, so a lock a
        // foreign live process holds — the `--force` path — is left exactly as it was.
        if (lock.acquired) releaseInstanceLock(HARNESS_RUNTIME_LOCK_KEY);
    }
}

// --- host reads ---------------------------------------------------------------

/** Store directory names any farm currently links to. Mirrors the provisioner's reclaim referenced-set scan. */
async function referencedStoreDirs(storeRoot: string): Promise<Set<string>> {
    const referenced = new Set<string>();
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return referenced;
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        // A dot-directory is a staging or superseded farm from an interrupted swap, not a real farm.
        if (entry.isDirectory() && !entry.name.startsWith(".")) await collectReferences(join(farmsDir, entry.name), referenced);
    }
    return referenced;
}

/** Walk one farm, adding the store directory name of every symlink that points into `store/`. */
async function collectReferences(dir: string, into: Set<string>): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            const target = await readlink(full);
            const marker = target.indexOf("/store/");
            if (marker !== -1) into.add(target.slice(marker + "/store/".length).split("/")[0]!);
        } else if (entry.isDirectory()) {
            // A promoted namespace directory holds more links; recurse into it.
            await collectReferences(full, into);
        }
    }
}

/** The store directories with their pins, sorted by directory name. */
async function readStorePackages(storeRoot: string): Promise<StorePackage[]> {
    const storeDir = join(storeRoot, "store");
    if (!existsSync(storeDir)) return [];
    const packages: StorePackage[] = [];
    for (const entry of await readdir(storeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        packages.push({ dir: entry.name, pin: await readPin(join(storeDir, entry.name)) });
    }
    return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The `name==version` pin recorded in a store directory, or `null` when the marker is absent or empty. */
async function readPin(dir: string): Promise<string | null> {
    try {
        const first = (await readFile(join(dir, PIN_MARKER), "utf8")).split("\n", 1)[0]?.trim() ?? "";
        return first === "" ? null : first;
    } catch {
        return null;
    }
}

/**
 * The track names a farm records in its `meta.json`, or an empty list when the file is absent, malformed,
 * or records no track. An unreadable file is not an error here: the inspection describes what is there,
 * and a farm with no readable metadata is one `store use` refuses anyway.
 */
async function readTracks(farmDir: string): Promise<readonly string[]> {
    try {
        const raw: unknown = JSON.parse(await readFile(join(farmDir, FARM_METADATA), "utf8"));
        if (typeof raw !== "object" || raw === null) return [];
        const tracks = (raw as Record<string, unknown>).tracks;
        return Array.isArray(tracks) ? tracks.filter((track): track is string => typeof track === "string") : [];
    } catch {
        return [];
    }
}

/** The farms with their link counts and their tracks, marking the one the pointer resolves to. */
async function readFarms(storeRoot: string, active: ActiveFarmPointer): Promise<StoreFarm[]> {
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return [];
    const farms: StoreFarm[] = [];
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dir = join(farmsDir, entry.name);
        farms.push({
            name: entry.name,
            active: active.state === "resolved" && active.farm === entry.name,
            links: await countSymlinks(dir),
            tracks: await readTracks(dir),
        });
    }
    return farms.sort((a, b) => a.name.localeCompare(b.name));
}

/** Count the symlinks under a farm, recursing into its real directories only. */
async function countSymlinks(dir: string): Promise<number> {
    let count = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) count += 1;
        else if (entry.isDirectory()) count += await countSymlinks(join(dir, entry.name));
    }
    return count;
}

/** Sum the bytes of the real files under a directory. Never follows a symlink, so a farm's links add nothing and a loop cannot form. */
async function dirBytes(dir: string): Promise<number> {
    if (!existsSync(dir)) return 0;
    let total = 0;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            total += await dirBytes(full);
        } else if (entry.isFile()) {
            try {
                total += (await lstat(full)).size;
            } catch {
                // A file that vanished mid-walk contributes nothing.
            }
        }
    }
    return total;
}

/** Create the store root so the engine binds an existing, user-owned directory. */
function ensureStoreRootExists(storeRoot: string): Result<void, ProvisionError> {
    try {
        mkdirSync(storeRoot, { recursive: true });
        return ok(undefined);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not create the package store at ${storeRoot}.`, cause });
    }
}

/** The last few non-empty lines of the provisioner output, for a failure message that names the real cause. */
function provisionerTail(text: string): string {
    const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line !== "");
    return lines.slice(-8).join("\n");
}

function errorText(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
}

// --- command actions ---------------------------------------------------------

/** Print an error and mark the process failed. */
function reportError(error: { readonly message: string }): void {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
}

/** `inflexa store add` — provision packages into the active farm. */
export async function runStoreAdd(specs: string[], options: { farm?: string }): Promise<void> {
    const storeRoot = env.libStoreDir;
    const farm = resolveActiveFarm(storeRoot, options.farm);
    console.log(`Provisioning into farm "${farm}" (network on). This can take some minutes.`);
    const result = await provisionPackages({ storeRoot, farm, specs }, { onProgress: (event) => console.log(event.line) });
    result.match(
        (outcome) => console.log(`Farm "${outcome.farm}" is ready.`),
        (error) => reportError(error),
    );
}

/**
 * `inflexa store download` — start the detached catalog transfer, or report why none is necessary.
 *
 * The command exits as soon as the process is on the machine. A detached process writes nothing to the
 * terminal of the starter, thus every branch names the command that reports the progress.
 *
 * `--update` is the consent to apply a moved tag, and it is not a way to transfer a healthy store a
 * second time: over a receipt that pins the manifest the registry serves now, the flag leaves the store
 * as it is.
 *
 * `runTransfer` is the detached child itself. It moves the bytes in this process, holds the download lock
 * for the whole run, and writes the row as it advances.
 */
export async function runStoreDownload(options: { update?: boolean; runTransfer?: boolean }): Promise<void> {
    const storeRoot = env.libStoreDir;
    if (options.runTransfer === true) {
        await runLibStoreTransfer({ storeRoot, update: options.update ?? false });
        return;
    }
    const result = await startLibStoreDownloadProcess({ storeRoot, update: options.update ?? false });
    result.match((outcome) => {
        switch (outcome.type) {
            case "started":
                console.log(`The package-store download runs in the background (pid ${outcome.pid}).`);
                console.log("Run `inflexa store ls` to see the progress, or `inflexa store cancel` to stop it.");
                return;
            case "already_running": {
                const row = outcome.report.row;
                console.log(`A package-store download is already running (pid ${outcome.report.holderPid ?? "unknown"}).`);
                if (row !== null) console.log(`  ${describeTransfer(row.bytesTransferred, row.totalBytes)}`);
                console.log("Run `inflexa store ls` to see the progress, or `inflexa store cancel` to stop it.");
                return;
            }
            case "up_to_date":
                console.log("The package store is up to date. Nothing was transferred.");
                return;
            case "update_available":
                console.log("A newer package store is available.");
                console.log(`  installed ${outcome.installedDigest}`);
                console.log(`  latest    ${outcome.latestDigest}`);
                console.log("Run `inflexa store download --update` to apply it. Nothing was transferred.");
                return;
            default: {
                const exhaustive: never = outcome;
                throw new Error(`unhandled download start outcome: ${JSON.stringify(exhaustive)}`);
            }
        }
    }, reportError);
}

/**
 * `inflexa store cancel` — stop the live catalog transfer, record `canceled`, and drop the partial
 * staged tree.
 *
 * A cancel of nothing is not a failure: with no live run the command reports that fact and changes
 * nothing. It removes no installed content, thus each child that the store root holds stays where it is.
 */
export async function runStoreCancel(): Promise<void> {
    const outcome = await cancelLibStoreDownload(env.libStoreDir);
    if (outcome.type === "no_run") {
        console.log("No package-store download is running. Nothing changed.");
        return;
    }
    console.log(`Stopped the package-store download (pid ${outcome.holderPid}) and removed the partial transfer.`);
    console.log("Each package and farm the store already holds stays. Run `inflexa store download` to start again.");
}

/** `inflexa store ls` — report the store's active farm, packages, farms, and disk use. */
export async function runStoreLs(): Promise<void> {
    const result = await inspectStore(env.libStoreDir);
    result.match(
        (inspection) => printInspection(inspection),
        (error) => reportError(error),
    );
}

/** `inflexa store use` — switch the active farm on the host. */
export async function runStoreUse(farm: string, options: { force?: boolean }): Promise<void> {
    const result = await storeUse({ storeRoot: env.libStoreDir, farm, force: options.force ?? false }, { onNotice: (line) => console.log(`  ${line}`) });
    result.match(
        (outcome) =>
            console.log(
                outcome.previous === null || outcome.previous === outcome.farm
                    ? `The active farm is "${outcome.farm}".`
                    : `The active farm is "${outcome.farm}" (it was "${outcome.previous}").`,
            ),
        (error) => reportError(error),
    );
}

/** `inflexa store remove-farm` — remove a farm's symlinks. */
export async function runStoreRemoveFarm(farm: string): Promise<void> {
    const result = await removeFarm({ storeRoot: env.libStoreDir, farm }, { onProgress: (event) => console.log(event.line) });
    result.match(
        () => console.log(`Removed farm "${farm}". Run \`inflexa store reclaim\` to drop the packages it alone referenced.`),
        (error) => reportError(error),
    );
}

/** `inflexa store reclaim` — report, then remove, store content no farm references. */
export async function runStoreReclaim(): Promise<void> {
    const storeRoot = env.libStoreDir;
    const preview = await reclaimPreview(storeRoot);
    if (preview.isErr()) return reportError(preview.error);
    const candidates = preview.value;
    if (candidates.length === 0) {
        console.log("No unreferenced packages. Nothing to reclaim.");
        return;
    }
    console.log("These store packages have no farm and will be removed:");
    for (const name of candidates) console.log(`  ${name}`);
    const result = await reclaimStore({ storeRoot }, { onProgress: (event) => console.log(event.line) });
    result.match(
        (outcome) => console.log(`Reclaimed ${outcome.reclaimed.length} package(s).`),
        (error) => reportError(error),
    );
}

/** Render the active-farm pointer as its one report line. */
function describeActive(active: ActiveFarmPointer): string {
    switch (active.state) {
        case "resolved":
            return active.farm;
        case "dangling":
            return `none — the pointer names "${active.farm}", which is not there. Run \`inflexa store use <farm>\` to select one.`;
        case "absent":
            return "none — run `inflexa store use <farm>` to select one.";
        default: {
            const exhaustive: never = active;
            throw new Error(`unhandled active-farm pointer: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** Render the bytes moved against the bytes the manifest declares. Before the manifest resolves there is no total, thus no ratio. */
function describeTransfer(bytesTransferred: number, totalBytes: number | null): string {
    return totalBytes === null
        ? `${formatBytes(bytesTransferred)} transferred — resolving the manifest`
        : `${formatBytes(bytesTransferred)} of ${formatBytes(totalBytes)}`;
}

/**
 * Render the download state as its report lines.
 *
 * Every branch is prose the user acts on. A failure reports its message and names the retry; a canceled
 * run says that the user stopped it and names the same retry; an absent row says that no download ran,
 * because a store can arrive by a route that wrote none. No branch opens a prompt.
 */
function printDownload(download: StoreDownloadInspection): void {
    switch (download.state) {
        case null:
            console.log("  Download no download ran — run `inflexa store download` to obtain the published catalog.");
            break;
        case "pending":
            console.log("  Download starting");
            break;
        case "running":
            console.log(`  Download running — ${describeTransfer(download.bytesTransferred, download.totalBytes)}`);
            break;
        case "installed":
            console.log("  Download installed");
            break;
        case "failed":
            console.log("  Download failed");
            if (download.message !== null) console.log(`    ${download.message}`);
            console.log("    Run `inflexa store download` to try again.");
            break;
        case "declined":
            console.log("  Download declined — run `inflexa store download` to obtain the published catalog.");
            break;
        case "canceled":
            console.log("  Download canceled — you stopped the transfer. Run `inflexa store download` to start again.");
            break;
        default: {
            const exhaustive: never = download.state;
            throw new Error(`unhandled download state: ${JSON.stringify(exhaustive)}`);
        }
    }
    if (download.updateAvailable) console.log("  Update   a newer package store is available — run `inflexa store download --update` to apply it.");
}

/** Print a store inspection as an aligned report. */
function printInspection(inspection: StoreInspection): void {
    console.log(`  Store    ${inspection.root}`);
    if (!inspection.exists) {
        console.log("  Present  no — run `inflexa store add <packages...>` to create it.");
        printDownload(inspection.download);
        return;
    }
    console.log(`  Active   ${describeActive(inspection.active)}`);
    console.log(`  Packages ${inspection.packages.length}`);
    for (const pkg of inspection.packages) console.log(`    ${pkg.pin ?? pkg.dir}`);
    console.log(`  Farms    ${inspection.farms.length}`);
    for (const farm of inspection.farms) {
        const tracks = farm.tracks.length === 0 ? "no tracks recorded" : `tracks: ${farm.tracks.join(", ")}`;
        console.log(`    ${farm.name}${farm.active ? " (active)" : ""}  ${farm.links} link(s)  ${tracks}`);
    }
    console.log(`  Disk     ${formatBytes(inspection.storeBytes)}`);
    printDownload(inspection.download);
}

/** Render a byte count in the largest unit that keeps it readable. */
function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KiB", "MiB", "GiB", "TiB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(1)} ${units[unit]}`;
}
