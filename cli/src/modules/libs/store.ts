/**
 * The `inflexa store` command actions — add, ls, remove-farm, reclaim — over the host package store.
 *
 * The store is a host directory the harness bind-mounts read-only at `/mnt/libs` when it is configured.
 * Three of the four commands MUTATE it, and they mutate it the same way the design intends: through the
 * provisioner container. The provisioner is the one container with network access and a compiler; it turns
 * a package spec into content-addressed files, assembles a per-analysis symlink farm, and flips the
 * `current` pointer. So `add`, `reclaim`, and `remove-farm` start it through `lib/container.ts` — the same
 * engine wrapper the image pull uses, so engine selection and socket resolution are not duplicated — and
 * each is approval-gated in the registry, like `sandbox pull`.
 *
 * `ls` is the exception: it only reads. It walks the store on the host filesystem directly, exactly as
 * `refs list` reads the reference store, so a passive inspection needs no container and writes no config.
 *
 * The provisioner image has NO default. Its source for a user machine is an open decision, so a command
 * that must run the container reads an explicit `harness.provisionerImage` and stops with guidance when it
 * is unset, rather than guessing a registry path that may not exist.
 */

import { existsSync, mkdirSync, readlinkSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { ensureRuntime } from "../../lib/config.ts";
import { stream, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { resolveHarnessConfig, resolveLibStore, resolveProvisionerImage, type ResolvedHarnessConfig } from "../harness/config.ts";

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

/**
 * The message the provisioner prints when a second run finds the store lock held. Matched so the CLI turns
 * a normal condition — two terminals — into an actionable message instead of a bare non-zero exit.
 */
const STORE_LOCK_PATTERN = /holds the store lock/;

/** Why a store-management action could not complete. Each variant maps to one actionable user message. */
export type ProvisionError =
    | { readonly type: "image_unconfigured"; readonly message: string }
    | { readonly type: "runtime_unavailable"; readonly message: string }
    | { readonly type: "store_locked"; readonly message: string }
    | { readonly type: "farm_not_found"; readonly farm: string; readonly message: string }
    | { readonly type: "provisioner_failed"; readonly code: number; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause: unknown };

/** A single progress line from the provisioner container, delivered to an observer as it lands. */
export type ProvisionProgress = { readonly type: "log"; readonly line: string };

/**
 * Caller-supplied hooks for a store-management action. `run` is the container seam — injected so a test
 * exercises the argument building and exit-code classification without a real engine. `onProgress` is a
 * notification channel over the provisioner's live output; it CANNOT fail the action, because a readout is
 * decoration over work that is otherwise succeeding (the reference-store installer's observer contract).
 */
export type ProvisionDeps = {
    readonly run?: ProvisionerRunner;
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

/** One farm, its name, whether `current` selects it, and how many symlinks it holds. */
export type StoreFarm = { readonly name: string; readonly active: boolean; readonly links: number };

/** A passive inspection of the store, read from the host filesystem. */
export type StoreInspection = {
    readonly root: string;
    readonly exists: boolean;
    readonly packages: readonly StorePackage[];
    readonly farms: readonly StoreFarm[];
    /** Bytes the deduplicated store content occupies (`store/` only — the farms are symlinks). */
    readonly storeBytes: number;
};

/** Deliver one progress event, swallowing anything the observer throws so it can never fail the run. */
function reportProgress(deps: ProvisionDeps, event: ProvisionProgress): void {
    try {
        deps.onProgress?.(event);
    } catch {
        // Intentionally empty: a progress readout is decoration over work that is otherwise succeeding.
    }
}

/** The error a command raises when it must run the provisioner but no image is configured. */
function imageUnconfigured(): ProvisionError {
    return {
        type: "image_unconfigured",
        message:
            "No provisioner image is configured. Set `harness.provisionerImage` in your config to the provisioner image reference, then run this command again.",
    };
}

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

/**
 * Provision packages into a farm, extending its closure. The provisioner unions the new specs with the
 * farm's earlier requests, so this passes only the new specs and the harness re-resolves the whole set —
 * an add is additive by design. Fails before touching the engine when no provisioner image is configured.
 */
export async function provisionPackages(
    params: { readonly storeRoot: string; readonly image: string | null; readonly farm: string; readonly specs: readonly string[] },
    deps: ProvisionDeps = {},
): Promise<Result<ProvisionOutcome, ProvisionError>> {
    if (params.image === null) return err(imageUnconfigured());
    // The bind-mount source must exist before the engine mounts it; a missing source would be
    // auto-created as a root-owned directory the user cannot manage.
    const ensured = ensureStoreRootExists(params.storeRoot);
    if (ensured.isErr()) return err(ensured.error);
    const run = deps.run ?? defaultRunner;
    const ran = await run({ image: params.image, storeRoot: params.storeRoot, network: "online", args: ["--farm", params.farm, ...params.specs] }, (line) =>
        reportProgress(deps, { type: "log", line }),
    );
    if (ran.isErr()) return err(ran.error);
    return classifyRun(ran.value).map(() => ({ farm: params.farm, specs: params.specs }));
}

/** Remove a farm's symlinks. The store directories it referenced stay until reclaim runs. */
export async function removeFarm(
    params: { readonly storeRoot: string; readonly image: string | null; readonly farm: string },
    deps: ProvisionDeps = {},
): Promise<Result<void, ProvisionError>> {
    if (params.image === null) return err(imageUnconfigured());
    const run = deps.run ?? defaultRunner;
    const ran = await run({ image: params.image, storeRoot: params.storeRoot, network: "offline", args: ["--remove-farm", params.farm] }, (line) =>
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
export async function reclaimStore(
    params: { readonly storeRoot: string; readonly image: string | null },
    deps: ProvisionDeps = {},
): Promise<Result<ReclaimOutcome, ProvisionError>> {
    const preview = await reclaimPreview(params.storeRoot);
    if (preview.isErr()) return err(preview.error);
    const candidates = preview.value;
    if (candidates.length === 0) return ok({ reclaimed: [] });
    if (params.image === null) return err(imageUnconfigured());
    const run = deps.run ?? defaultRunner;
    const ran = await run({ image: params.image, storeRoot: params.storeRoot, network: "offline", args: ["--reclaim"] }, (line) =>
        reportProgress(deps, { type: "log", line }),
    );
    if (ran.isErr()) return err(ran.error);
    return classifyRun(ran.value).map(() => ({ reclaimed: candidates }));
}

/**
 * Inspect the store from the host filesystem: its packages, its farms, and the disk the content occupies.
 * Read-only by construction — it takes no container seam, so no command routed through it can remove
 * content. An absent root is a normal state, reported as `exists: false`, not an error.
 */
export async function inspectStore(storeRoot: string): Promise<Result<StoreInspection, ProvisionError>> {
    try {
        if (!existsSync(storeRoot)) return ok({ root: storeRoot, exists: false, packages: [], farms: [], storeBytes: 0 });
        const packages = await readStorePackages(storeRoot);
        const farms = await readFarms(storeRoot);
        const storeBytes = await dirBytes(join(storeRoot, "store"));
        return ok({ root: storeRoot, exists: true, packages, farms, storeBytes });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
    }
}

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

/** The farms with their link counts, marking the one `current` selects. */
async function readFarms(storeRoot: string): Promise<StoreFarm[]> {
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return [];
    const active = readCurrentTarget(storeRoot);
    const farms: StoreFarm[] = [];
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        farms.push({ name: entry.name, active: entry.name === active, links: await countSymlinks(join(farmsDir, entry.name)) });
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

/**
 * The store root the commands operate on: the configured `harness.libStorePath` when set, else the default
 * `env.libStoreDir`. The default lets a user create and populate a store before opting in by setting the
 * config; boot never falls back to it, so a cleared config key is still a clean opt-out.
 */
function resolveStoreRoot(cfg: ResolvedHarnessConfig): string {
    const location = resolveLibStore(cfg);
    return location.configured ? location.path : env.libStoreDir;
}

/** The configured provisioner image reference, or `null` when none is set. */
function resolveImage(cfg: ResolvedHarnessConfig): string | null {
    const location = resolveProvisionerImage(cfg);
    return location.configured ? location.image : null;
}

/** Print an error and mark the process failed. */
function reportError(error: ProvisionError): void {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
}

/** `inflexa store add` — provision packages into the active farm. */
export async function runStoreAdd(specs: string[], options: { farm?: string }): Promise<void> {
    const cfg = resolveHarnessConfig();
    const storeRoot = resolveStoreRoot(cfg);
    const farm = resolveActiveFarm(storeRoot, options.farm);
    console.log(`Provisioning into farm "${farm}" (network on). This can take some minutes.`);
    const result = await provisionPackages({ storeRoot, image: resolveImage(cfg), farm, specs }, { onProgress: (event) => console.log(event.line) });
    result.match(
        (outcome) => console.log(`Farm "${outcome.farm}" is ready.`),
        (error) => reportError(error),
    );
}

/** `inflexa store ls` — report the store's packages, farms, and disk use. */
export async function runStoreLs(): Promise<void> {
    const cfg = resolveHarnessConfig();
    const result = await inspectStore(resolveStoreRoot(cfg));
    result.match(
        (inspection) => printInspection(inspection),
        (error) => reportError(error),
    );
}

/** `inflexa store remove-farm` — remove a farm's symlinks. */
export async function runStoreRemoveFarm(farm: string): Promise<void> {
    const cfg = resolveHarnessConfig();
    const result = await removeFarm({ storeRoot: resolveStoreRoot(cfg), image: resolveImage(cfg), farm }, { onProgress: (event) => console.log(event.line) });
    result.match(
        () => console.log(`Removed farm "${farm}". Run \`inflexa store reclaim\` to drop the packages it alone referenced.`),
        (error) => reportError(error),
    );
}

/** `inflexa store reclaim` — report, then remove, store content no farm references. */
export async function runStoreReclaim(): Promise<void> {
    const cfg = resolveHarnessConfig();
    const storeRoot = resolveStoreRoot(cfg);
    const preview = await reclaimPreview(storeRoot);
    if (preview.isErr()) return reportError(preview.error);
    const candidates = preview.value;
    if (candidates.length === 0) {
        console.log("No unreferenced packages. Nothing to reclaim.");
        return;
    }
    console.log("These store packages have no farm and will be removed:");
    for (const name of candidates) console.log(`  ${name}`);
    const result = await reclaimStore({ storeRoot, image: resolveImage(cfg) }, { onProgress: (event) => console.log(event.line) });
    result.match(
        (outcome) => console.log(`Reclaimed ${outcome.reclaimed.length} package(s).`),
        (error) => reportError(error),
    );
}

/** Print a store inspection as an aligned report. */
function printInspection(inspection: StoreInspection): void {
    console.log(`  Store    ${inspection.root}`);
    if (!inspection.exists) {
        console.log("  Present  no — run `inflexa store add <packages...>` to create it.");
        return;
    }
    console.log(`  Packages ${inspection.packages.length}`);
    for (const pkg of inspection.packages) console.log(`    ${pkg.pin ?? pkg.dir}`);
    console.log(`  Farms    ${inspection.farms.length}`);
    for (const farm of inspection.farms) console.log(`    ${farm.name}${farm.active ? " (active)" : ""}  ${farm.links} link(s)`);
    console.log(`  Disk     ${formatBytes(inspection.storeBytes)}`);
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
