/**
 * The `inflexa store` command actions — add, ls, remove-farm, reclaim — over the host package store.
 *
 * The store is a host directory the harness bind-mounts read-only at `/mnt/libs` for EVERY sandbox. Its
 * root is `env.libStoreDir`, a CLI-owned path: these commands write exactly where boot reads, and no
 * config value moves either side. The store is not optional. The runtime image bakes no R library and no
 * Python library, so a sandbox with no store mounted can import nothing.
 *
 * The store holds one content-addressed `store/` pool and per-farm symlink trees under `farms/`. There is
 * NO active farm at the store level. Each analysis owns the farm `farms/<analysisId>`, composition makes
 * it, and the sandbox of that analysis mounts it. The farm the download brings, {@link CATALOG_FARM}, is
 * the template: composition reads its lock for the default closure and links its warm caches.
 *
 * `inflexa store add` is ACQUISITION and it does no farm work. It resolves a spec, downloads it into the
 * pool, and appends the resolved edges to the dependency graph. The farm of an analysis changes only
 * through composition. Two requests for one spec share one flight — refer to `store_flight.ts`.
 *
 * The provisioner container starts ONLY for an operation that installs packages or mutates the store
 * under the store lock. It is the one container with network access and a compiler, and it owns the
 * per-store lock, so `add`, `reclaim`, and `remove-farm` start it through `lib/container.ts` — the same
 * engine wrapper the image pull uses, so engine selection and socket resolution are not duplicated.
 *
 * The other operations are host filesystem work and start NO container: the list of what the store holds,
 * the reclaim preview, and the composition of a farm. The provisioner image is measured in gigabytes, so
 * a container start is a real cost that a read or a link must not pay.
 *
 * The provisioner image reference is the {@link PROVISIONER_IMAGE} constant. No configuration value names
 * it and none can move it: the provisioner offers no variant, so a user chooses nothing. A command that
 * must start the container obtains the image when the machine does not hold it, rather than refusing.
 */

import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "neverthrow";

import { ensureRuntime } from "../../lib/config.ts";
import { stream, type CaptureResult } from "../../lib/container.ts";
import { env } from "../../lib/env.ts";
import { acquireInstanceLock, releaseInstanceLock, LIB_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { listAnalyses } from "../../db/primary_query.ts";
import {
    analysisFarmPath,
    describeFarmCompositionError,
    extendFarm,
    nameOfStoreDir,
    readDepsGraph,
    removeAnalysisFarm,
    type DepsGraph,
} from "./composition.ts";
import { PROVISIONER_IMAGE } from "./images.ts";
import { ensureProvisionerImage } from "./pull.ts";
import {
    cancelLibStoreDownload,
    installedLibStoreManifest,
    readLibStoreDownloadReport,
    runLibStoreTransfer,
    startLibStoreDownloadProcess,
    type LibStoreDownloadStatus,
} from "./store_download.ts";
import {
    canonicalDistributionName,
    describeLibStoreFlightSpec,
    parseLibStoreFlightSpec,
    readLibStoreFlights,
    withLibStoreFlight,
    type LibStoreFlightError,
    type LibStoreFlightOutcome,
    type LibStoreFlightSpec,
    type LibStoreFlightStatus,
} from "./store_flight.ts";

/** The path the store is mounted at in both the provisioner (read-write) and the sandbox (read-only). */
const LIB_MOUNT = "/mnt/libs";

/**
 * The farm the published catalog brings. It is the TEMPLATE and never an environment: composition reads
 * its lock for the default closure of a new analysis farm, and it links the warm caches of this farm into
 * each one. The publisher writes the name (`.github/workflows/lib-store-provisioner.yml`).
 */
const CATALOG_FARM = "catalog";

/**
 * The active-farm pointer of the OLD store layout, at the store root.
 *
 * Nothing writes it and nothing reads it. It is named here so the first store command after the upgrade
 * removes it — refer to {@link removeStaleActiveFarmPointer}.
 */
const LEGACY_ACTIVE_FARM_POINTER = "current";

/** The pin marker the provisioner writes inside each store directory, recording its `name==version`. */
const PIN_MARKER = ".inflexa-pin";

/** The store metadata a complete farm carries, recording its version, its architecture, and its tracks. */
const FARM_METADATA = "meta.json";

/** How long a reclamation waits for the live acquisition flights to finish before it refuses. */
const FLIGHT_WAIT_MS = 600_000;

/** How often a reclamation tests whether the flights finished. */
const FLIGHT_POLL_MS = 250;

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
    | { readonly type: "reclaim_in_flight"; readonly message: string }
    | { readonly type: "acquisition_in_flight"; readonly message: string }
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
    /**
     * Stop the container in flight. An acquisition flight whose last subscriber cancelled aborts through
     * this, so the work does not finish for nobody.
     */
    readonly signal?: AbortSignal;
    /** Report what a reclamation would remove, INSIDE the exclusivity window, before it removes anything. */
    readonly onPreview?: (candidates: readonly string[]) => void;
    /** How long a reclamation waits for the live flights. Default: {@link FLIGHT_WAIT_MS}. Injected by a test. */
    readonly flightWaitMs?: number;
    /** How long one wait step of a reclamation is. Default: {@link FLIGHT_POLL_MS}. Injected by a test. */
    readonly flightPollMs?: number;
};

/** What the provisioner container is asked to do: the image, the store to mount, the network, and its arguments. */
export type ProvisionerInvocation = {
    readonly image: string;
    readonly storeRoot: string;
    /** `online` for acquisition (it reaches the package index); `offline` for reclaim and farm removal, which touch only local disk. */
    readonly network: "online" | "offline";
    /** The arguments passed to the provisioner entry point (for example `scanpy`, `--reclaim`, `--remove-farm x`). */
    readonly args: readonly string[];
};

/** No container engine was available to start the provisioner. */
export type RuntimeUnavailableError = { readonly type: "runtime_unavailable"; readonly message: string };

/**
 * How the provisioner container is started. The default resolves and pins a container runtime, then
 * streams the provisioner through `lib/container.ts`. Injected so a test drives the command logic against
 * a fake, and so no test ever starts a real container.
 */
export type ProvisionerRunner = (
    invocation: ProvisionerInvocation,
    onLine: (line: string) => void,
    signal?: AbortSignal,
) => Promise<Result<CaptureResult, RuntimeUnavailableError>>;

/** A completed acquisition run, carrying the specs it acquired into the pool. */
export type ProvisionOutcome = { readonly specs: readonly string[] };

/** A completed reclamation run, carrying the store directories it removed and the orphan farms it reaped. */
export type ReclaimOutcome = {
    readonly reclaimed: readonly string[];
    /** The farms whose analysis the database no longer holds. The reaper removed them before the preview. */
    readonly farmsReaped: readonly string[];
};

/** One stored distribution, by its store directory name and the pin it records (`name==version`, or `null` when the marker is absent). */
export type StorePackage = { readonly dir: string; readonly pin: string | null };

/** One farm: its name, what it belongs to, how many symlinks it holds, and the tracks it carries. */
export type StoreFarm = {
    /** The directory name under `farms/`. For an analysis farm that name IS the analysis id. */
    readonly name: string;
    /** True for the catalog farm the download brings, which composition reads as the template. */
    readonly template: boolean;
    /**
     * The name of the analysis that owns the farm, or `null`.
     *
     * `null` covers the template, and it also covers an analysis farm whose analysis the database no
     * longer holds — a normal disagreement between the folders and the database, and the orphan-farm
     * reaper of the reclamation is what settles it.
     */
    readonly analysisName: string | null;
    readonly links: number;
    /**
     * The track names the farm's `meta.json` records, for example `python` and `r`. Empty when the file
     * records none or cannot be read. A farm with fewer tracks than another is the reason an import fails
     * in one analysis and not in another, so the inspection reports it.
     */
    readonly tracks: readonly string[];
};

/** One live acquisition flight as the listing reports it. */
export type StoreFlightInspection = {
    /** The normalized spec of the flight, as a user reads it. */
    readonly spec: string;
    /** The live state: waiting for a slot under the cap, or running. */
    readonly state: LibStoreFlightStatus;
    /** The analyses subscribed, by name where the database holds one and by id where it does not. */
    readonly analyses: readonly string[];
};

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
    readonly packages: readonly StorePackage[];
    readonly farms: readonly StoreFarm[];
    /** The acquisition flights that are live now. Empty is the common state. */
    readonly flights: readonly StoreFlightInspection[];
    /** Bytes the deduplicated store content occupies (`store/` only — the farms are symlinks). */
    readonly storeBytes: number;
    /**
     * Bytes held by store content that no farm references — the space `inflexa store reclaim` would
     * recover. An update adds only the content whose hash changed and it removes nothing, thus an old
     * version stays on disk until a reclaim runs. The listing reports this so a user sees the reclaimable
     * disk without running the reclaim preview.
     */
    readonly reclaimableBytes: number;
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
const defaultRunner: ProvisionerRunner = async (invocation, onLine, signal) => {
    const rtResult = await ensureRuntime();
    if (rtResult.isErr()) return err({ type: "runtime_unavailable", message: rtResult.error.message });
    const rt = rtResult.value;
    // The store mounts read-write here — the sandbox mounts the same root read-only — because the
    // provisioner writes packages into it. `mountArg` already yields a read-write bind for both engines
    // (Podman's `:z` adds a shared SELinux relabel, never a read-only flag). An acquisition needs the
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
        return ok(await stream(rt, args, onLine, signal));
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
 * Remove the active-farm pointer of the old store layout, one time and in silence.
 *
 * The layout carried a `current` symlink at the store root, and a sandbox mounted whatever it resolved
 * to. Each sandbox now mounts the farm of its analysis, thus the pointer selects nothing and it means
 * nothing. Each store command calls this, so an installed store upgrades in place at its first use.
 *
 * It removes a SYMLINK and nothing else. A real directory named `current` is content that somebody else
 * put there, and this is a migration step, not a cleanup of the store root. A second call changes
 * nothing, and an absent pointer is the normal state after the first one.
 *
 * No farm is rebuilt: a farm link names a store directory under `store/`, thus no link ever involved the
 * pointer.
 */
export function removeStaleActiveFarmPointer(storeRoot: string): void {
    const pointer = join(storeRoot, LEGACY_ACTIVE_FARM_POINTER);
    try {
        if (!lstatSync(pointer).isSymbolicLink()) return;
        rmSync(pointer, { force: true });
    } catch {
        // An absent pointer is the normal state, and an unreadable store root is a fault that the command
        // itself reports with its own message. A migration step must fail no command.
    }
}

/**
 * Acquire packages into the content-addressed pool.
 *
 * It does NO farm work. The provisioner resolves the specs, downloads the closure into `store/`, and
 * appends the resolved edges to the dependency graph. The farm of an analysis changes only through
 * composition, which links from the pool on the host.
 */
export async function provisionPackages(
    params: { readonly storeRoot: string; readonly specs: readonly string[] },
    deps: ProvisionDeps = {},
): Promise<Result<ProvisionOutcome, ProvisionError>> {
    // A live download merges its staged tree into the store root ONE CHILD AT A TIME, so an acquisition
    // run that writes into the same pool during that merge can meet a half-merged root. The refusal covers
    // the whole live period. A row of `running` whose holder is gone reads as failed, thus a dead
    // downloader refuses nothing.
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
        { image: PROVISIONER_IMAGE, storeRoot: params.storeRoot, network: "online", args: [...params.specs] },
        (line) => reportProgress(deps, { type: "log", line }),
        deps.signal,
    );
    if (ran.isErr()) return err(ran.error);
    return classifyRun(ran.value).map(() => ({ specs: params.specs }));
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
 * Remove store content no farm references, EXCLUSIVELY against the acquisition flights.
 *
 * The exclusivity has two halves, and both are necessary. The reclaim lock blocks a NEW flight for the
 * whole run, because a flight acquires into the pool and it would reference a directory that this run is
 * about to free. The wait then holds this run until each flight that is already live finishes, thus a
 * reclaim deletes nothing a flight wrote.
 *
 * The preview runs INSIDE that window and it is reported through `deps.onPreview`, so the set the user
 * reads is the set the provisioner removes. A preview outside the window could name a directory that a
 * flight referenced a moment later.
 *
 * The orphan-farm reaper runs FIRST, inside the same window. A farm holds the store directories that it
 * links, thus a farm whose analysis is gone keeps pool content alive for nobody. The reaper removes it,
 * and the preview that follows then names the content that the removal freed.
 *
 * The provisioner holds the store lock for the delete, so a concurrent write from another process cannot
 * race it. It runs only when there is something to remove, thus a clean store costs no engine start.
 */
export async function reclaimStore(params: { readonly storeRoot: string }, deps: ProvisionDeps = {}): Promise<Result<ReclaimOutcome, ProvisionError>> {
    const lock = acquireInstanceLock(LIB_STORE_RECLAIM_LOCK_KEY);
    if (!lock.acquired) {
        return err({
            type: "reclaim_in_flight",
            message: `Another \`inflexa\` process (pid ${lock.holderPid}) is reclaiming this package store. Wait for it to finish, then run this command again.`,
        });
    }
    try {
        const settled = await waitForNoFlights(deps.flightWaitMs ?? FLIGHT_WAIT_MS, deps.flightPollMs ?? FLIGHT_POLL_MS);
        if (settled.isErr()) return err(settled.error);
        const farmsReaped = await reapOrphanFarms(params.storeRoot, deps);
        const preview = await reclaimPreview(params.storeRoot);
        if (preview.isErr()) return err(preview.error);
        const candidates = preview.value;
        deps.onPreview?.(candidates);
        if (candidates.length === 0) return ok({ reclaimed: [], farmsReaped });
        const image = await (deps.ensureImage ?? defaultEnsureImage)();
        if (image.isErr()) return err(image.error);
        const run = deps.run ?? defaultRunner;
        const ran = await run({ image: PROVISIONER_IMAGE, storeRoot: params.storeRoot, network: "offline", args: ["--reclaim"] }, (line) =>
            reportProgress(deps, { type: "log", line }),
        );
        if (ran.isErr()) return err(ran.error);
        return classifyRun(ran.value).map(() => ({ reclaimed: candidates, farmsReaped }));
    } finally {
        releaseInstanceLock(LIB_STORE_RECLAIM_LOCK_KEY);
    }
}

/**
 * Remove each farm whose analysis the database no longer holds.
 *
 * `analysis delete` removes the farm of the analysis, thus this pass exists for the case that route
 * cannot cover: a database that the user replaced or removed, and a delete that a crash stopped between
 * the two stores. The folders and the database are entitled to disagree, and a farm that nothing can
 * reach again would otherwise hold pool content for ever.
 *
 * It runs ONLY here, because reclamation is never implicit. The template farm is never an orphan: it
 * belongs to the catalog and to no analysis. A farm that a lease holds is not removed either — a live
 * sandbox resolves those links right now — and {@link removeAnalysisFarm} is what makes that check.
 *
 * A database that cannot answer names NO orphan. The alternative would read an unreadable table as an
 * empty one, and it would then remove every farm of the store.
 */
async function reapOrphanFarms(storeRoot: string, deps: ProvisionDeps): Promise<string[]> {
    const analyses = listAnalyses();
    if (analyses.isErr()) {
        reportProgress(deps, { type: "log", line: "[reap] the analyses table could not be read; no farm was reaped" });
        return [];
    }
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return [];
    const known = new Set(analyses.value.map((analysis) => analysis.id));
    const reaped: string[] = [];
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        // A dot-directory is a staging or a superseded farm from an interrupted swap of the provisioner,
        // and `--repair` owns it.
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name === CATALOG_FARM || known.has(entry.name)) continue;
        const removed = await removeAnalysisFarm({ storeRoot, analysisId: entry.name });
        removed.match(
            (outcome) => {
                if (!outcome.removed) return;
                reaped.push(entry.name);
                reportProgress(deps, { type: "log", line: `[reap] removed the farm of the analysis ${entry.name}, which the database no longer holds` });
            },
            (error) => reportProgress(deps, { type: "log", line: `[reap] kept the farm ${entry.name}: ${describeFarmCompositionError(error)}` }),
        );
    }
    return reaped;
}

/** Hold a reclamation until no acquisition flight is live, and refuse when the wait runs out. */
async function waitForNoFlights(waitMs: number, pollMs: number): Promise<Result<void, ProvisionError>> {
    for (let waited = 0; ; waited += pollMs) {
        const flights = readLibStoreFlights();
        if (flights.length === 0) return ok(undefined);
        if (waited >= waitMs) {
            const names = flights.map((flight) => `${flight.row.name}${flight.row.specifier}`).join(", ");
            return err({
                type: "acquisition_in_flight",
                message: `A package acquisition is still in flight (${names}), and a reclaim must not free what it is about to reference. Wait for it to finish, then run this command again.`,
            });
        }
        await Promise.sleep(pollMs);
    }
}

/**
 * Inspect the store from the host filesystem: its packages, its farms with their owners and their tracks,
 * the live acquisition flights, and the disk the content occupies. Read-only by construction — it takes no
 * container seam, so no command routed through it can remove content. An absent root is a normal state,
 * reported as `exists: false`, not an error.
 *
 * The farms and the flights each name an analysis, thus this reads the analyses table. A name the table
 * does not hold degrades to `null` and to the id, because the folders and the database can disagree and
 * a listing that failed on that would be worse than a listing that reports it.
 */
export async function inspectStore(storeRoot: string): Promise<Result<StoreInspection, ProvisionError>> {
    try {
        const download = await inspectStoreDownload(storeRoot);
        const flights = readStoreFlights();
        if (!existsSync(storeRoot)) {
            return ok({ root: storeRoot, exists: false, packages: [], farms: [], flights, storeBytes: 0, reclaimableBytes: 0, download });
        }
        const packages = await readStorePackages(storeRoot);
        const farms = await readFarms(storeRoot);
        const storeBytes = await dirBytes(join(storeRoot, "store"));
        const reclaimableBytes = await reclaimableStoreBytes(storeRoot);
        return ok({ root: storeRoot, exists: true, packages, farms, flights, storeBytes, reclaimableBytes, download });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
    }
}

/** The analysis names by id, or an empty map when the database cannot answer. A miss is a name the listing does without. */
function analysisNamesById(): ReadonlyMap<string, string> {
    return new Map(
        listAnalyses()
            .unwrapOr([])
            .map((analysis) => [analysis.id, String(analysis.name)]),
    );
}

/** The live acquisition flights, with each subscriber named where the database holds a name for it. */
function readStoreFlights(): readonly StoreFlightInspection[] {
    const flights = readLibStoreFlights();
    if (flights.length === 0) return [];
    const names = analysisNamesById();
    return flights.map((flight) => ({
        spec: describeLibStoreFlightSpec(flight.row),
        state: flight.row.state,
        analyses: flight.analysisIds.map((id) => names.get(id) ?? id),
    }));
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
 * and a farm the harness would refuse to mount is exactly what the reader must see.
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

/**
 * The farms with their owners, their link counts, and their tracks.
 *
 * The directory name carries the identity: the catalog farm is the template, and each other name is the
 * id of the analysis that owns the farm. The analyses table gives the name of that analysis. A farm whose
 * analysis the table no longer holds reports no name, which is the state the orphan-farm reaper settles.
 */
async function readFarms(storeRoot: string): Promise<StoreFarm[]> {
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return [];
    const names = analysisNamesById();
    const farms: StoreFarm[] = [];
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const dir = join(farmsDir, entry.name);
        const template = entry.name === CATALOG_FARM;
        farms.push({
            name: entry.name,
            template,
            analysisName: template ? null : (names.get(entry.name) ?? null),
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

/**
 * Bytes held by store directories no farm references — the space `inflexa store reclaim` would recover.
 *
 * It reuses the referenced-set scan the reclaim uses ({@link referencedStoreDirs}), so the readout and the
 * removal agree. An update never removes an old version, thus this number grows until a reclaim runs.
 */
async function reclaimableStoreBytes(storeRoot: string): Promise<number> {
    const storeDir = join(storeRoot, "store");
    if (!existsSync(storeDir)) return 0;
    const referenced = await referencedStoreDirs(storeRoot);
    let total = 0;
    for (const entry of await readdir(storeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || referenced.has(entry.name)) continue;
        total += await dirBytes(join(storeDir, entry.name));
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

/**
 * `inflexa store add` — acquire package specs into the content-addressed pool.
 *
 * Each spec becomes ONE flight, keyed by its normalized form. Thus a spec that another request is
 * already acquiring starts no second container: this call subscribes and it reports the progress of that
 * flight. The flights of different specs run at the same time, under the configured concurrency cap.
 *
 * The command does NO farm work. The farm of an analysis changes only through composition.
 *
 * The subscription of this command belongs to no analysis, because the command takes none: it is a
 * terminal that asked for a package, and it has no farm to extend.
 */
export async function runStoreAdd(specs: string[]): Promise<void> {
    const storeRoot = env.libStoreDir;
    removeStaleActiveFarmPointer(storeRoot);
    const parsed: LibStoreFlightSpec[] = [];
    for (const raw of specs) {
        const spec = parseLibStoreFlightSpec(raw, "python");
        if (spec.isErr()) {
            reportError(spec.error);
            return;
        }
        parsed.push(spec.value);
    }
    console.log(`Acquiring ${parsed.length} spec(s) into the package pool (network on). This can take some minutes.`);
    // Concurrently, because the cap is what bounds the parallelism and a sequential loop would ignore it.
    // A spec whose flight another caller owns waits inside its own call, thus it holds up no other spec.
    const outcomes = await Promise.all(parsed.map((spec) => acquireOneSpec(storeRoot, spec)));
    for (const outcome of outcomes) {
        outcome.match((flight) => {
            switch (flight.type) {
                case "flew":
                    console.log(`Acquired ${describeLibStoreFlightSpec(flight.spec)} into the pool.`);
                    return;
                case "joined":
                    console.log(`${describeLibStoreFlightSpec(flight.spec)} was already in flight, and that flight finished.`);
                    console.log("Run `inflexa store ls` to see what the store holds now.");
                    return;
                case "canceled":
                    console.log(`The flight for ${describeLibStoreFlightSpec(flight.spec)} stopped, because no analysis waits for it.`);
                    return;
                default: {
                    const exhaustive: never = flight;
                    throw new Error(`unhandled flight outcome: ${JSON.stringify(exhaustive)}`);
                }
            }
        }, reportError);
    }
}

/**
 * Acquire one spec as a flight, streaming the provisioner output of whichever caller owns that flight.
 *
 * The baseline is read BEFORE the flight, thus the store directories that appear while the flight runs are
 * what the acquisition added — refer to {@link extendFarmsForFlight}.
 */
function acquireOneSpec(
    storeRoot: string,
    spec: LibStoreFlightSpec,
): Promise<Result<LibStoreFlightOutcome<ProvisionOutcome>, ProvisionError | LibStoreFlightError>> {
    const baseline = new Set(
        readDepsGraph(storeRoot).match(
            (graph) => [...graph.nodes.keys()],
            () => [],
        ),
    );
    return withLibStoreFlight(
        {
            spec,
            analysisId: null,
            onProgress: (line) => console.log(line),
            extendSubscriberFarms: ({ spec: acquired, analysisIds }) => extendFarmsForFlight({ storeRoot, spec: acquired, analysisIds, baseline }),
        },
        async ({ signal, onProgress }) =>
            provisionPackages(
                { storeRoot, specs: [`${spec.name}${spec.specifier}`] },
                {
                    signal,
                    onProgress: (event) => {
                        console.log(event.line);
                        onProgress(event.line);
                    },
                },
            ),
    );
}

/**
 * Extend the farm of each analysis that subscribed to a flight, with what the flight acquired.
 *
 * The flight knows the SPEC and never the store directories: the provisioner resolves the spec, writes the
 * pool, and appends the resolved edges to the graph under its commit mutex. Thus the graph is what names
 * the result, and the canonical name of the spec is what finds it there. A store directory of that name
 * that the baseline did not hold is what this acquisition added, and it is the root of the extension. When
 * the pool already held the distribution, nothing appears, and the store directories of that name are the
 * roots — that is the same package, acquired again for a second analysis.
 *
 * An analysis with NO farm is skipped, and that is the lazy rule and not an omission: an analysis that
 * started no sandbox owns no farm, and a farm made here would be a farm that nothing asked for. Its first
 * sandbox composes the default closure, and the import failure of the package extends it on demand.
 *
 * Nothing here can fail the acquisition. The packages are in the pool whatever the farms do, thus a
 * refused extension is a report and never an error: `inflexa store ls` shows what the store holds now.
 */
export async function extendFarmsForFlight(params: {
    readonly storeRoot: string;
    readonly spec: LibStoreFlightSpec;
    readonly analysisIds: readonly string[];
    /** The store directories that the graph held before the flight ran. */
    readonly baseline: ReadonlySet<string>;
}): Promise<void> {
    if (params.analysisIds.length === 0) return;
    const graph = readDepsGraph(params.storeRoot);
    if (graph.isErr()) {
        console.log(`  No farm was extended: ${describeFarmCompositionError(graph.error)}.`);
        return;
    }
    const named = storeDirsOfName(graph.value, params.spec.name);
    const appeared = named.filter((storeDir) => !params.baseline.has(storeDir));
    const roots = appeared.length > 0 ? appeared : named;
    if (roots.length === 0) {
        console.log(`  No farm was extended: the dependency graph names no store directory for ${params.spec.name}.`);
        return;
    }
    for (const analysisId of params.analysisIds) {
        if (!existsSync(analysisFarmPath(params.storeRoot, analysisId))) continue;
        const extended = await extendFarm({ storeRoot: params.storeRoot, analysisId, roots });
        extended.match(
            () => console.log(`  Extended the farm of the analysis ${analysisId}.`),
            (error) => console.log(`  The farm of the analysis ${analysisId} was not extended: ${describeFarmCompositionError(error)}.`),
        );
    }
}

/** The store directories of the graph that record one canonical distribution name. */
function storeDirsOfName(graph: DepsGraph, name: string): string[] {
    return [...graph.nodes.keys()]
        .filter((storeDir) => {
            const recorded = nameOfStoreDir(storeDir);
            return recorded !== null && canonicalDistributionName(recorded) === name;
        })
        .sort();
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
    removeStaleActiveFarmPointer(storeRoot);
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
    removeStaleActiveFarmPointer(env.libStoreDir);
    const outcome = await cancelLibStoreDownload(env.libStoreDir);
    if (outcome.type === "no_run") {
        console.log("No package-store download is running. Nothing changed.");
        return;
    }
    console.log(`Stopped the package-store download (pid ${outcome.holderPid}) and removed the partial transfer.`);
    console.log("Each package and farm the store already holds stays. Run `inflexa store download` to start again.");
}

/** `inflexa store ls` — report the packages, the farms, the live flights, and the disk use of the store. */
export async function runStoreLs(): Promise<void> {
    removeStaleActiveFarmPointer(env.libStoreDir);
    const result = await inspectStore(env.libStoreDir);
    result.match(
        (inspection) => printInspection(inspection),
        (error) => reportError(error),
    );
}

/** `inflexa store remove-farm` — remove a farm's symlinks. */
export async function runStoreRemoveFarm(farm: string): Promise<void> {
    removeStaleActiveFarmPointer(env.libStoreDir);
    const result = await removeFarm({ storeRoot: env.libStoreDir, farm }, { onProgress: (event) => console.log(event.line) });
    result.match(
        () => console.log(`Removed farm "${farm}". Run \`inflexa store reclaim\` to drop the packages it alone referenced.`),
        (error) => reportError(error),
    );
}

/**
 * `inflexa store reclaim` — report, then remove, store content no farm references.
 *
 * The report comes from `onPreview`, thus it lands INSIDE the exclusivity window that `reclaimStore`
 * holds. A preview that this action took itself, before that window, could name a directory that a
 * flight referenced a moment later.
 */
export async function runStoreReclaim(): Promise<void> {
    const storeRoot = env.libStoreDir;
    removeStaleActiveFarmPointer(storeRoot);
    const result = await reclaimStore(
        { storeRoot },
        {
            onProgress: (event) => console.log(event.line),
            onPreview: (candidates) => {
                if (candidates.length === 0) {
                    console.log("No unreferenced packages. Nothing to reclaim.");
                    return;
                }
                console.log("These store packages have no farm and will be removed:");
                for (const name of candidates) console.log(`  ${name}`);
            },
        },
    );
    result.match((outcome) => {
        // The reaped farms come first, because they are the reason that some of the packages below had no
        // farm left at the preview.
        if (outcome.farmsReaped.length > 0) console.log(`Removed ${outcome.farmsReaped.length} farm(s) whose analysis is gone.`);
        if (outcome.reclaimed.length > 0) console.log(`Reclaimed ${outcome.reclaimed.length} package(s).`);
    }, reportError);
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

/**
 * Render what one farm belongs to.
 *
 * The template is the catalog farm, and composition reads it for each analysis. Each other farm belongs
 * to one analysis, thus its name is what a reader recognizes. A farm whose analysis the database no
 * longer holds says so, because that farm is exactly what the orphan-farm reaper removes.
 */
function describeFarmOwner(farm: StoreFarm): string {
    if (farm.template) return "template";
    return farm.analysisName === null ? "no analysis — a reclaim removes it" : `analysis "${farm.analysisName}"`;
}

/** Print a store inspection as an aligned report. */
function printInspection(inspection: StoreInspection): void {
    console.log(`  Store    ${inspection.root}`);
    if (!inspection.exists) {
        console.log("  Present  no — run `inflexa store download` to obtain the published catalog.");
        printFlights(inspection.flights);
        printDownload(inspection.download);
        return;
    }
    console.log(`  Packages ${inspection.packages.length}`);
    for (const pkg of inspection.packages) console.log(`    ${pkg.pin ?? pkg.dir}`);
    console.log(`  Farms    ${inspection.farms.length}`);
    for (const farm of inspection.farms) {
        const tracks = farm.tracks.length === 0 ? "no tracks recorded" : `tracks: ${farm.tracks.join(", ")}`;
        console.log(`    ${farm.name}  ${describeFarmOwner(farm)}  ${farm.links} link(s)  ${tracks}`);
    }
    printFlights(inspection.flights);
    console.log(`  Disk     ${formatBytes(inspection.storeBytes)}`);
    // An update keeps each old version, thus a reclaimable total shows the disk that `inflexa store reclaim`
    // frees. A zero total is the common state, and printing it would be noise, so the line stays silent then.
    if (inspection.reclaimableBytes > 0) {
        console.log(`  Reclaim  ${formatBytes(inspection.reclaimableBytes)} unreferenced — run \`inflexa store reclaim\` to recover it`);
    }
    printDownload(inspection.download);
}

/**
 * Print the acquisition flights that are live now.
 *
 * No flight is the common state, and a "Flights 0" line would be noise, thus the block stays silent
 * then. A live flight names its spec, its state, and the analyses subscribed, because those three answer
 * "what is this machine doing, and for whom".
 */
function printFlights(flights: readonly StoreFlightInspection[]): void {
    if (flights.length === 0) return;
    console.log(`  Flights  ${flights.length}`);
    for (const flight of flights) {
        const analyses = flight.analyses.length === 0 ? "no analysis subscribed" : `analyses: ${flight.analyses.join(", ")}`;
        console.log(`    ${flight.spec}  ${flight.state}  ${analyses}`);
    }
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
