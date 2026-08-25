/**
 * The `inflexa store` command actions — add, link, ls, download, cancel,
 * reclaim — over the host package store.
 *
 * The store is a host directory the harness bind-mounts read-only at
 * `/mnt/libs` for EVERY sandbox. Its root is `env.packageStoreDir`, a
 * CLI-owned path: these commands write exactly where boot reads, and no config
 * value moves either side. The store is not optional. The runtime image bakes
 * no R library and no Python library, so a sandbox with no store mounted can
 * import nothing.
 *
 * `inflexa store add` takes ONE package per call, with `--version`, `--lang`,
 * and `--analysis`. An approved add ENQUEUES into the pending set, and the
 * flush runs one one-shot provisioner `acquire` for the whole batch — refer to
 * `store_flight.ts` for the two-phase flight. A direct terminal add flushes at
 * once, and the agent route enqueues and returns, because the batch of a turn
 * must not split.
 *
 * `inflexa store link` is the other half, and it is a command of its own. It
 * links what the pool already holds into the farm of one analysis, thus it
 * acquires nothing and it costs milliseconds. The two take different consent
 * from the user, and a policy binds to a command and never to a flag.
 *
 * The provisioner container starts ONLY for an operation that installs
 * packages or mutates the pool under the store lock: the flush of an add, and
 * the reclaim. The listing, the reclaim preview, and the link are host
 * filesystem work and start NO container.
 */

import { existsSync, mkdirSync } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { isCancel, select as clackSelect } from "@clack/prompts";
import { err, ok, type Result } from "neverthrow";

import { readFarmLock } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { acquireInstanceLock, liveInstanceLockHolds, releaseInstanceLock, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import type { IdOrName } from "../../lib/types.ts";
import { listAnalyses, listPendingStoreAdds } from "../../db/primary_query.ts";
import type { Analysis } from "../../types/analysis.ts";
import { findAnalysis } from "../analysis/analysis.ts";
import {
    describeFarmCompositionError,
    extendFarm,
    FARM_LOCK_KEY_PREFIX,
    readDepsGraph,
    removeAnalysisFarm,
    resolvePackageRequest,
    CATALOG_FARM,
    type RequestResolutionError,
    type ResolvedRequest,
} from "./composition.ts";
import { classifyProvisionerRun, runProvisioner, type ProvisionerError, type ProvisionerRunner } from "./provisioner.ts";
import { cancelCatalogTransfer, installedCatalogManifest, runCatalogTransfer, startCatalogTransfer } from "./store_download.ts";
import {
    anyLiveStoreFlight,
    describeStoreFlightSpec,
    enqueueStoreAdd,
    flushPendingStoreAdds,
    readStoreFlights,
    type FlushSpecOutcome,
    type StoreEcosystem,
    type StoreFlightStatus,
} from "./store_flight.ts";
import { readTransferReport } from "./transfers.ts";
import { spawnDetachedSelf } from "./transfers.ts";

/** The pin marker the provisioner writes inside each store directory, recording its `name==version`. */
const PIN_MARKER = ".inflexa-pin";

/** How long a reclamation waits for the live acquisition flights and the live compositions before it refuses. */
const FLIGHT_WAIT_MS = 600_000;

/** How often a reclamation tests whether the flights and the compositions finished. */
const FLIGHT_POLL_MS = 250;

/**
 * The hidden flag that tells a re-invoked `inflexa store add` to run the flush
 * of the pending set in-process. The chat spawns exactly this when the asks of
 * a turn settle. The registry declares the same spelling as a hidden option.
 */
export const STORE_FLUSH_FLAG = "--run-flush";

/**
 * The hidden flag of the agent route: enqueue and return, with no flush. The
 * run-inflexa tool passes it, thus the batch of one agent turn shares one
 * provisioner run instead of splitting per approval.
 */
export const STORE_QUEUED_FLAG = "--queued";

/** Start the detached flush child. The chat calls this when the asks of a turn settle and the pending set is not empty. */
export function startPendingFlushChild(): number | null {
    if (listPendingStoreAdds().unwrapOr([]).length === 0) return null;
    try {
        return spawnDetachedSelf(["store", "add", STORE_FLUSH_FLAG]);
    } catch {
        return null;
    }
}

/** Why a store-management action could not complete. Each variant maps to one actionable user message. */
export type StoreActionError =
    | ProvisionerError
    | { readonly type: "reclaim_in_flight"; readonly message: string }
    | { readonly type: "acquisition_in_flight"; readonly message: string }
    | { readonly type: "composition_in_flight"; readonly message: string }
    | { readonly type: "io_failed"; readonly message: string; readonly cause: unknown };

/** A completed reclamation run, carrying the store directories it removed and the orphan farms it reaped. */
export type ReclaimOutcome = {
    readonly reclaimed: readonly string[];
    /** The farms whose analysis the database no longer holds. The reaper removed them before the preview. */
    readonly farmsReaped: readonly string[];
};

/** Caller-supplied hooks for the reclaim. Injected so a test drives the flow without a real engine. */
export type ReclaimDeps = {
    readonly run?: ProvisionerRunner;
    readonly onProgress?: (line: string) => void;
    /** Report what a reclamation would remove, INSIDE the exclusivity window, before it removes anything. */
    readonly onPreview?: (candidates: readonly string[]) => void;
    /** How long a reclamation waits for the live flights and the live compositions. Default: {@link FLIGHT_WAIT_MS}. */
    readonly flightWaitMs?: number;
    /** How long one wait step of a reclamation is. Default: {@link FLIGHT_POLL_MS}. */
    readonly flightPollMs?: number;
};

// --- The inspection ------------------------------------------------------------

/** One stored distribution, by its store directory name and the pin it records (`name==version`, or `null` when the marker is absent). */
export type StorePackage = { readonly dir: string; readonly pin: string | null };

/** One farm: its name, what it belongs to, how many symlinks it holds, and the tracks its lock records. */
export type StoreFarm = {
    /** The directory name under `farms/`. For an analysis farm that name IS the analysis id. */
    readonly name: string;
    /** True for the catalog farm the download brings, which an extension reads as the template. */
    readonly template: boolean;
    /**
     * The name of the analysis that owns the farm, or `null`.
     *
     * `null` covers the catalog, and it also covers an analysis farm whose analysis the database no
     * longer holds — a normal disagreement between the folders and the database, and the orphan-farm
     * reaper of the reclamation is what settles it.
     */
    readonly analysisName: string | null;
    readonly links: number;
    /**
     * The track names the `inflexa.lock` of the farm records, deduplicated to the two runtimes. Empty
     * when the lock is absent or unreadable — which is exactly the farm the harness mount gate
     * refuses, and the reader must see it.
     */
    readonly tracks: readonly string[];
};

/** One live acquisition flight as the listing reports it. */
export type StoreFlightInspection = {
    /** The spec of the flight, as a user reads it. */
    readonly spec: string;
    /** The live state: waiting for a slot under the cap, or running. */
    readonly state: StoreFlightStatus;
    /** The analyses subscribed, by name where the database holds one and by id where it does not. */
    readonly analyses: readonly string[];
};

/** One pending add of the queue, as the listing reports it. */
export type StorePendingInspection = {
    readonly spec: string;
    readonly analysis: string | null;
};

/** What the inspection reports about the catalog transfer. */
export type StoreDownloadInspection = {
    /** The lifecycle state the reader acts on, or `null` when no download ran. */
    readonly state: "pending" | "running" | "installed" | "failed" | "declined" | "canceled" | null;
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
    /** The enqueued adds that no flush took yet. Empty is the common state. */
    readonly pending: readonly StorePendingInspection[];
    /** Bytes the deduplicated store content occupies (`store/` only — the farms are symlinks). */
    readonly storeBytes: number;
    /**
     * Bytes held by store content that no farm references — the space `inflexa store reclaim` would
     * recover. An update adds only the content whose hash changed and it removes nothing, thus an old
     * version stays on disk until a reclaim runs.
     */
    readonly reclaimableBytes: number;
    /** The state of the catalog transfer. It describes the process, and it decides nothing about usability. */
    readonly download: StoreDownloadInspection;
};

/**
 * Inspect the store from the host filesystem: its packages, its farms with
 * their owners and their tracks, the live flights, the pending adds, and the
 * disk the content occupies. Read-only by construction — it takes no container
 * seam, so no command routed through it can remove content. An absent root is a
 * normal state, reported as `exists: false`, not an error.
 */
export async function inspectStore(storeRoot: string): Promise<Result<StoreInspection, StoreActionError>> {
    try {
        const download = await inspectStoreDownload(storeRoot);
        const flights = readFlightInspections();
        const pending = readPendingInspections();
        if (!existsSync(storeRoot)) {
            return ok({ root: storeRoot, exists: false, packages: [], farms: [], flights, pending, storeBytes: 0, reclaimableBytes: 0, download });
        }
        const packages = await readStorePackages(storeRoot);
        const farms = await readFarms(storeRoot);
        const storeBytes = await dirBytes(join(storeRoot, "store"));
        const reclaimableBytes = await reclaimableStoreBytes(storeRoot);
        return ok({ root: storeRoot, exists: true, packages, farms, flights, pending, storeBytes, reclaimableBytes, download });
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
function readFlightInspections(): readonly StoreFlightInspection[] {
    const flights = readStoreFlights();
    if (flights.length === 0) return [];
    const names = analysisNamesById();
    return flights.map((flight) => ({
        spec: describeStoreFlightSpec(flight.row),
        state: flight.row.state,
        analyses: flight.analysisIds.map((id) => names.get(id) ?? id),
    }));
}

/** The pending adds, with the analysis named where the database holds a name. */
function readPendingInspections(): readonly StorePendingInspection[] {
    const pending = listPendingStoreAdds().unwrapOr([]);
    if (pending.length === 0) return [];
    const names = analysisNamesById();
    return pending.map((entry) => ({
        spec: describeStoreFlightSpec(entry),
        analysis: entry.analysisId === null ? null : (names.get(entry.analysisId) ?? entry.analysisId),
    }));
}

/**
 * The download half of the inspection: the transfer report, plus the update
 * comparison. An update is available when the receipt pins one manifest and the
 * last resolve saw a different one. Both halves are local, thus the listing
 * needs no network and it opens no prompt — the user owns the decision, and
 * `inflexa store download --update` is the consent that applies it.
 */
async function inspectStoreDownload(storeRoot: string): Promise<StoreDownloadInspection> {
    const report = readTransferReport("catalog");
    const latest = report.row?.digest ?? null;
    const installed = latest === null ? null : await installedCatalogManifest(storeRoot);
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
    const candidates = [join(dir, PIN_MARKER)];
    try {
        // An R store directory nests the package one level down, thus its pin sits inside the inner directory.
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) candidates.push(join(dir, entry.name, PIN_MARKER));
        }
    } catch {
        return null;
    }
    for (const candidate of candidates) {
        try {
            const first = (await readFile(candidate, "utf8")).split("\n", 1)[0]?.trim() ?? "";
            if (first !== "") return first;
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * The runtime tracks the `inflexa.lock` of a farm records, deduplicated: the
 * lock names a link subtree per package (`python`, `cran`, `bioconductor`,
 * `github`), and the reader wants the two runtimes.
 */
function readTracks(farmDir: string): readonly string[] {
    return readFarmLock(farmDir).match(
        (lock) => {
            const tracks = new Set<string>();
            for (const entry of lock.packages) tracks.add(entry.track === "python" ? "python" : "r");
            return [...tracks].sort();
        },
        () => [],
    );
}

/**
 * The farms with their owners, their link counts, and their tracks.
 *
 * The directory name carries the identity: the catalog farm is the template,
 * and each other name is the id of the analysis that owns the farm. The
 * analyses table gives the name of that analysis. A farm whose analysis the
 * table no longer holds reports no name, which is the state the orphan-farm
 * reaper settles.
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
            tracks: readTracks(dir),
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
 * Bytes held by store directories no farm references — the space `inflexa
 * store reclaim` would recover. It reuses the referenced-set scan the reclaim
 * uses ({@link referencedStoreDirs}), so the readout and the removal agree.
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

// --- The reclamation -----------------------------------------------------------

/**
 * The store directories no farm references — the set reclamation would remove.
 * Computed on the host so a command can report it before removing anything.
 * This mirrors the provisioner's own referenced-set scan, so the preview and
 * the removal agree unless a concurrent run changes the store between them.
 */
export async function reclaimPreview(storeRoot: string): Promise<Result<readonly string[], StoreActionError>> {
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
 * Remove store content no farm references, EXCLUSIVELY against the acquisition
 * flights and against the farm compositions.
 *
 * The exclusivity has two halves, and both are necessary. The reclaim lock
 * blocks a NEW flight and a NEW composition for the whole run, because a flight
 * acquires into the pool and a composition links what the pool already holds.
 * The wait then holds this run until each flight and each composition that is
 * already live finishes, thus a reclaim deletes nothing a flight wrote and
 * nothing a composition is about to link.
 *
 * The two locks are taken in ONE order, and that order is what prevents a
 * deadlock: this run takes the reclaim lock first, and it takes a per-farm key
 * later, inside the orphan-farm reaper. A composition never holds a per-farm
 * key while it waits for the reclaim lock — refer to `composition.ts`.
 *
 * The preview runs INSIDE that window and it is reported through
 * `deps.onPreview`, so the set the user reads is the set the provisioner
 * removes. The orphan-farm reaper runs FIRST, inside the same window: a farm
 * whose analysis is gone keeps pool content alive for nobody, and the preview
 * that follows names the content the removal freed.
 */
/** The graph nodes whose store directory is gone. An unreadable graph reads as none, because with no graph there is nothing to heal. */
function danglingGraphNodes(storeRoot: string): readonly string[] {
    const read = readDepsGraph(storeRoot);
    if (read.isErr()) return [];
    return [...read.value.nodes.keys()].filter((dir) => !existsSync(join(storeRoot, "store", dir)));
}

export async function reclaimStore(params: { readonly storeRoot: string }, deps: ReclaimDeps = {}): Promise<Result<ReclaimOutcome, StoreActionError>> {
    const lock = acquireInstanceLock(PACKAGE_STORE_RECLAIM_LOCK_KEY);
    if (!lock.acquired) {
        return err({
            type: "reclaim_in_flight",
            message: `Another \`inflexa\` process (pid ${lock.holderPid}) is reclaiming this package store. Wait for it to finish, then run this command again.`,
        });
    }
    try {
        const settled = await waitForNoLiveWork(deps.flightWaitMs ?? FLIGHT_WAIT_MS, deps.flightPollMs ?? FLIGHT_POLL_MS);
        if (settled.isErr()) return err(settled.error);
        const farmsReaped = await reapOrphanFarms(params.storeRoot, deps);
        const preview = await reclaimPreview(params.storeRoot);
        if (preview.isErr()) return err(preview.error);
        const candidates = preview.value;
        deps.onPreview?.(candidates);
        // A dangling graph node justifies the run on its own: the provisioner
        // prunes the graph entries of gone directories, and only its run heals
        // a graph that advertises a package no link can land.
        if (candidates.length === 0 && danglingGraphNodes(params.storeRoot).length === 0) return ok({ reclaimed: [], farmsReaped });
        const run = deps.run ?? runProvisioner;
        const ran = await run({ storeRoot: params.storeRoot, egressAllow: null, args: ["reclaim"] }, (line) => deps.onProgress?.(line));
        if (ran.isErr()) return err(ran.error);
        return classifyProvisionerRun(ran.value).map(() => ({ reclaimed: candidates, farmsReaped }));
    } finally {
        releaseInstanceLock(PACKAGE_STORE_RECLAIM_LOCK_KEY);
    }
}

/**
 * Remove each farm whose analysis the database no longer holds.
 *
 * `analysis delete` removes the farm of the analysis, thus this pass exists
 * for the case that route cannot cover: a database that the user replaced or
 * removed, and a delete that a crash stopped between the two stores. The
 * folders and the database are entitled to disagree, and a farm that nothing
 * can reach again would otherwise hold pool content for ever.
 *
 * It runs ONLY here, because a reclamation is never implicit. The catalog farm
 * is never an orphan: it belongs to the catalog and to no analysis. A database
 * that cannot answer names NO orphan — the alternative would read an
 * unreadable table as an empty one, and it would then remove every farm.
 */
async function reapOrphanFarms(storeRoot: string, deps: ReclaimDeps): Promise<string[]> {
    const analyses = listAnalyses();
    if (analyses.isErr()) {
        deps.onProgress?.("[reap] the analyses table could not be read; no farm was reaped");
        return [];
    }
    const farmsDir = join(storeRoot, "farms");
    if (!existsSync(farmsDir)) return [];
    const known = new Set(analyses.value.map((analysis) => analysis.id));
    const reaped: string[] = [];
    for (const entry of await readdir(farmsDir, { withFileTypes: true })) {
        // A dot-directory is a staging or a superseded farm from an interrupted swap of the provisioner.
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name === CATALOG_FARM || known.has(entry.name)) continue;
        const removed = await removeAnalysisFarm({ storeRoot, analysisId: entry.name });
        removed.match(
            (outcome) => {
                if (!outcome.removed) return;
                reaped.push(entry.name);
                deps.onProgress?.(`[reap] removed the farm of the analysis ${entry.name}, which the database no longer holds`);
            },
            (error) => deps.onProgress?.(`[reap] kept the farm ${entry.name}: ${describeFarmCompositionError(error)}`),
        );
    }
    return reaped;
}

/**
 * Hold a reclamation until no acquisition flight and no farm composition is
 * live, and refuse when the wait runs out.
 *
 * A flight records its liveness on its own row, and a composition records it
 * on the per-farm lock that it holds for its whole critical section. One pid
 * probe stands behind both, thus a record that a dead process left blocks
 * neither one.
 */
async function waitForNoLiveWork(waitMs: number, pollMs: number): Promise<Result<void, StoreActionError>> {
    for (let waited = 0; ; waited += pollMs) {
        const flights = readStoreFlights();
        const compositions = liveInstanceLockHolds(FARM_LOCK_KEY_PREFIX);
        if (flights.length === 0 && compositions.length === 0) return ok(undefined);
        if (waited >= waitMs) {
            if (flights.length > 0) {
                const names = flights.map((flight) => `${flight.row.name}${flight.row.specifier}`).join(", ");
                return err({
                    type: "acquisition_in_flight",
                    message: `A package acquisition is still in flight (${names}), and a reclaim must not free what it is about to reference. Wait for it to finish, then run this command again.`,
                });
            }
            const pids = [...new Set(compositions.map((hold) => hold.pid))].join(", ");
            return err({
                type: "composition_in_flight",
                message: `A farm composition is still running (pid ${pids}), and a reclaim must not free what it is about to link. Wait for it to finish, then run this command again.`,
            });
        }
        await Promise.sleep(pollMs);
    }
}

// --- command actions ----------------------------------------------------------

/** Print an error and mark the process failed. */
function reportError(error: { readonly message: string }): void {
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
}

/** Why an `--analysis` reference could not become an analysis. Each variant is one user message. */
type FarmAnalysisError = { readonly type: "analysis_not_found"; readonly message: string } | { readonly type: "query_failed"; readonly message: string };

/**
 * The analysis that a farm-bearing reference names, resolved in ONE query and
 * id first. `store add` and `store link` share it, thus one reference reaches
 * one analysis by one rule, and the two commands refuse an unknown reference
 * with one message.
 */
function resolveFarmAnalysis(ref: IdOrName): Result<Analysis, FarmAnalysisError> {
    return findAnalysis(ref)
        .mapErr((error): FarmAnalysisError => ({ type: "query_failed", message: `Could not read the analyses (${error.type}).` }))
        .andThen((analysis) =>
            analysis === null
                ? err<Analysis, FarmAnalysisError>({
                      type: "analysis_not_found",
                      message: `No analysis matches "${ref}". Run \`inflexa ls\` to see the analyses this machine holds.`,
                  })
                : ok(analysis),
        );
}

/** The flags of `inflexa store add`. */
export type StoreAddOptions = {
    /** One exact version, or `null` for the newest the index serves. */
    readonly version: string | null;
    /** The ecosystem, or `null` for a name the acquire run resolves. */
    readonly lang: StoreEcosystem | null;
    /** The analysis whose farm the add extends after the commit. */
    readonly analysis: IdOrName | null;
    /** The agent route: enqueue and return, with no flush. */
    readonly queued?: boolean;
    /** The detached flush child: flush the pending set in-process. */
    readonly runFlush?: boolean;
};

/** Render one flush outcome as its report lines. */
function printFlushOutcome(outcome: FlushSpecOutcome): void {
    switch (outcome.kind) {
        case "acquired":
            console.log(
                `Acquired ${describeStoreFlightSpec(outcome.spec)} into the pool (${outcome.storeDirs.length} store director${outcome.storeDirs.length === 1 ? "y" : "ies"}).`,
            );
            return;
        case "joined":
            console.log(`${describeStoreFlightSpec(outcome.spec)} is already in flight in another process. Run \`inflexa store ls\` to watch it.`);
            return;
        case "refused":
            reportError({ message: `${describeStoreFlightSpec(outcome.spec)}: ${outcome.reason}` });
            return;
        case "both_hit": {
            const pair = outcome.candidates.map((candidate) => `--lang ${candidate.ecosystem}`).join(" or ");
            reportError({
                message:
                    `Both ecosystems hold "${outcome.spec.name}". Nothing was installed. ` +
                    `Run \`inflexa store add ${outcome.spec.name}\` again with ${pair} to name the one you want.`,
            });
            return;
        }
        default: {
            const unreachable: never = outcome;
            throw new Error(`unhandled flush outcome: ${JSON.stringify(unreachable)}`);
        }
    }
}

/** Run one flush and print its outcomes, sharing the shape between the terminal add and the flush child. */
async function flushAndPrint(storeRoot: string): Promise<void> {
    const flushed = await flushPendingStoreAdds(storeRoot, { onProgress: (line) => console.log(line) });
    flushed.match((result) => {
        switch (result.type) {
            case "empty":
                console.log("The pending set is empty. Nothing to acquire.");
                return;
            case "deferred":
                console.log(`The batch did not run: ${result.reason}.`);
                return;
            case "flew":
                for (const outcome of result.outcomes) printFlushOutcome(outcome);
                return;
            default: {
                const unreachable: never = result;
                throw new Error(`unhandled flush result: ${JSON.stringify(unreachable)}`);
            }
        }
    }, reportError);
}

/**
 * `inflexa store add` — acquire ONE package into the content-addressed pool.
 *
 * The add ENQUEUES into the pending set. The agent route (`--queued`) returns
 * at once, because the batch of one turn must not split per approval — the
 * chat flushes when the asks of the turn settle. A direct terminal add flushes
 * at once, in-process, and streams the provisioner output.
 */
export async function runStoreAdd(pkg: string | undefined, options: StoreAddOptions): Promise<void> {
    const storeRoot = env.packageStoreDir;

    if (options.runFlush === true) {
        await flushAndPrint(storeRoot);
        return;
    }

    if (pkg === undefined || pkg.trim() === "") {
        reportError({
            message: "`inflexa store add` takes exactly one package. Write `inflexa store add <name>`, with `--version <v>` for one exact version.",
        });
        return;
    }
    // One package per call is the rule of the command surface. A second name
    // would ride the version flag or the argument list, and commander already
    // refuses extra arguments — this refusal covers the embedded-space form.
    if (/\s/.test(pkg.trim())) {
        reportError({ message: "`inflexa store add` takes exactly one package per call. Run the command once per package." });
        return;
    }

    let analysisId: string | null = null;
    if (options.analysis !== null) {
        const target = resolveFarmAnalysis(options.analysis);
        if (target.isErr()) {
            reportError(target.error);
            return;
        }
        analysisId = target.value.id;
    }

    const enqueued = enqueueStoreAdd({ name: pkg.trim(), version: options.version, ecosystem: options.lang, analysisId });
    if (enqueued.isErr()) {
        reportError(enqueued.error);
        return;
    }

    if (options.queued === true) {
        console.log(`Queued ${describeStoreFlightSpec(enqueued.value)} for acquisition. The flight starts when the asks of this turn settle.`);
        console.log("Run `inflexa store ls` to see the queue and the flights.");
        return;
    }

    // The direct terminal add is the explicit flush: the batch is whatever the
    // pending set holds now, including adds that other approvals enqueued.
    try {
        mkdirSync(storeRoot, { recursive: true });
    } catch (cause) {
        reportError({ message: `Could not create the package store at ${storeRoot} (${cause instanceof Error ? cause.message : String(cause)}).` });
        return;
    }
    console.log("Acquiring into the package pool (network on, egress allowlisted). This can take some minutes.");
    await flushAndPrint(storeRoot);
}

/**
 * `inflexa store link` — link packages the pool already holds into the farm of
 * one analysis.
 *
 * It ACQUIRES nothing. It starts no container, it opens no network connection:
 * it reads the dependency graph, it resolves each requirement against the
 * pool, and it writes symbolic links. An acquisition is `inflexa store add`,
 * which takes minutes and holds the network open, and that difference is why
 * the two are two commands and not one command with a flag.
 *
 * The whole request set resolves BEFORE one link is written. Thus a call that
 * names a package the pool does not hold reports each refusal at one time, and
 * the farm stays exactly as it was.
 */
export async function runStoreLink(packages: string[], options: { readonly analysis: IdOrName | null; readonly lang: StoreEcosystem | null }): Promise<void> {
    const storeRoot = env.packageStoreDir;
    if (options.analysis === null) {
        reportError({
            message:
                "`inflexa store link` needs the analysis whose farm gains the links. Pass `--analysis <id|name>`, and run `inflexa ls` to see the analyses this machine holds.",
        });
        return;
    }
    const target = resolveFarmAnalysis(options.analysis);
    if (target.isErr()) {
        reportError(target.error);
        return;
    }
    const graph = readDepsGraph(storeRoot);
    if (graph.isErr()) {
        reportError({ message: `Could not read what the package pool holds: ${describeFarmCompositionError(graph.error)}.` });
        return;
    }

    const resolved: ResolvedRequest[] = [];
    const refusals: string[] = [];
    for (const requirement of packages) {
        const split = requirement.indexOf("==");
        const request = {
            name: split < 0 ? requirement.trim() : requirement.slice(0, split).trim(),
            ...(split < 0 ? {} : { version: requirement.slice(split + 2).trim() }),
            ...(options.lang === null ? {} : { ecosystem: options.lang }),
        };
        const answer = resolvePackageRequest(graph.value, request);
        if (answer.isOk()) {
            resolved.push(answer.value);
            continue;
        }
        // The both-hit stops with an ask on a terminal, because an interactive
        // command asks the user. A caller with no terminal gets the refusal with
        // the two candidates as guidance, and it re-runs with `--lang`.
        if (answer.error.type === "ambiguous_ecosystem" && process.stdin.isTTY) {
            const chosen = await clackSelect({
                message: `Both ecosystems hold "${answer.error.name}". Which one do you mean?`,
                options: [
                    { value: "python" as const, label: `Python (${answer.error.candidates[0]})` },
                    { value: "r" as const, label: `R (${answer.error.candidates[1]})` },
                ],
            });
            if (!isCancel(chosen)) {
                const retried = resolvePackageRequest(graph.value, { ...request, ecosystem: chosen });
                if (retried.isOk()) {
                    resolved.push(retried.value);
                    continue;
                }
                refusals.push(describeRequestRefusal(retried.error));
                continue;
            }
        }
        refusals.push(describeRequestRefusal(answer.error));
    }
    if (refusals.length > 0) {
        reportError({ message: refusals.join("\n\n  ") });
        return;
    }

    const analysis = target.value;
    const extended = await extendFarm({ storeRoot, analysisId: analysis.id, roots: resolved.map((answer) => answer.storeDir) });
    extended.match(
        (composition) => {
            for (const answer of resolved) console.log(`Linked ${answer.name}==${answer.version} into the farm of "${analysis.name}".`);
            console.log(`That farm links ${composition.storeDirs.length} store directories now.`);
            console.log("A live sandbox of the analysis resolves them at its next import, thus no restart is necessary.");
        },
        (error) => reportError({ message: `The farm of "${analysis.name}" was not extended: ${describeFarmCompositionError(error)}.` }),
    );
}

/**
 * One refusal that a person, or an agent, can act on. A bare "not found" is
 * what sends a caller around the same loop for ever, thus each message names
 * the remedy.
 */
function describeRequestRefusal(error: RequestResolutionError): string {
    switch (error.type) {
        case "unknown_distribution":
            return `The package pool holds nothing named "${error.name}". Run \`inflexa store add ${error.name}\` to acquire it — the acquisition covers PyPI, CRAN, and Bioconductor.`;
        case "unknown_version":
            return (
                `The package pool holds no version ${error.version} of "${error.name}". It holds ${error.available.join(", ")}. ` +
                `Link one of those versions, or run \`inflexa store add ${error.name} --version ${error.version}\` to acquire the one you named.`
            );
        case "ambiguous_ecosystem":
            return (
                `Both ecosystems hold "${error.name}" (${error.candidates.join(" and ")}), and the request names none. ` +
                "Run the command again with `--lang python` or `--lang r`."
            );
        default: {
            // The union is closed, thus the compiler proves that this is unreachable.
            const unreachable: never = error;
            throw new Error(`unhandled package request refusal: ${JSON.stringify(unreachable)}`);
        }
    }
}

/**
 * `inflexa store download` — start the detached catalog transfer, or report
 * why none is necessary.
 *
 * The command exits as soon as the process is on the machine. A detached
 * process writes nothing to the terminal of the starter, thus every branch
 * names the surface that reports the progress.
 *
 * `--update` is the consent to apply a moved tag, and it is not a way to
 * transfer a healthy store a second time: over a receipt that pins the
 * manifest the registry serves now, the flag leaves the store as it is.
 */
export async function runStoreDownload(options: { update?: boolean; runTransfer?: boolean }): Promise<void> {
    const storeRoot = env.packageStoreDir;
    if (options.runTransfer === true) {
        await runCatalogTransfer({ storeRoot, update: options.update ?? false });
        return;
    }
    const result = await startCatalogTransfer({ storeRoot, update: options.update ?? false });
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
                const unreachable: never = outcome;
                throw new Error(`unhandled download start outcome: ${JSON.stringify(unreachable)}`);
            }
        }
    }, reportError);
}

/**
 * `inflexa store cancel` — stop the live catalog transfer, record `canceled`,
 * and drop the partial staged tree.
 *
 * A cancel of nothing is not a failure: with no live run the command reports
 * that fact and changes nothing. It removes no installed content.
 */
export async function runStoreCancel(): Promise<void> {
    const outcome = await cancelCatalogTransfer(env.packageStoreDir);
    if (outcome.type === "no_run") {
        console.log("No package-store download is running. Nothing changed.");
        return;
    }
    console.log(`Stopped the package-store download (pid ${outcome.holderPid}) and removed the partial transfer.`);
    console.log("Each package and farm the store already holds stays. Run `inflexa store download` to start again.");
}

/** `inflexa store ls` — report the packages, the farms, the flights, the queue, and the disk use of the store. */
export async function runStoreLs(): Promise<void> {
    const result = await inspectStore(env.packageStoreDir);
    result.match(
        (inspection) => printInspection(inspection),
        (error) => reportError(error),
    );
}

/**
 * `inflexa store reclaim` — report, then remove, store content no farm
 * references. The report comes from `onPreview`, thus it lands INSIDE the
 * exclusivity window that `reclaimStore` holds.
 */
export async function runStoreReclaim(): Promise<void> {
    const result = await reclaimStore(
        { storeRoot: env.packageStoreDir },
        {
            onProgress: (line) => console.log(line),
            onPreview: (candidates) => {
                if (candidates.length === 0) {
                    // The run can still proceed past an empty preview: a dangling
                    // graph node heals through the provisioner prune, and its
                    // lines print through onProgress.
                    console.log("No unreferenced packages.");
                    return;
                }
                console.log("These store packages have no farm and will be removed:");
                for (const name of candidates) console.log(`  ${name}`);
            },
        },
    );
    result.match((outcome) => {
        // The reaped farms come first, because they are the reason that some of the
        // packages below had no farm left at the preview.
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
 * Render the download state as its report lines. Every branch is prose the
 * user acts on, and no branch opens a prompt.
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
            const unreachable: never = download.state;
            throw new Error(`unhandled download state: ${JSON.stringify(unreachable)}`);
        }
    }
    if (download.updateAvailable) console.log("  Update   a newer package store is available — run `inflexa store download --update` to apply it.");
}

/** Render what one farm belongs to. */
function describeFarmOwner(farm: StoreFarm): string {
    if (farm.template) return "catalog";
    return farm.analysisName === null ? "no analysis — a reclaim removes it" : `analysis "${farm.analysisName}"`;
}

/** Print a store inspection as an aligned report. */
function printInspection(inspection: StoreInspection): void {
    console.log(`  Store    ${inspection.root}`);
    if (!inspection.exists) {
        console.log("  Present  no — run `inflexa store download` to obtain the published catalog.");
        printFlights(inspection.flights);
        printPending(inspection.pending);
        printDownload(inspection.download);
        return;
    }
    console.log(`  Packages ${inspection.packages.length}`);
    for (const pkg of inspection.packages) console.log(`    ${pkg.pin ?? pkg.dir}`);
    console.log(`  Farms    ${inspection.farms.length}`);
    for (const farm of inspection.farms) {
        const tracks = farm.tracks.length === 0 ? "no lock" : `tracks: ${farm.tracks.join(", ")}`;
        console.log(`    ${farm.name}  ${describeFarmOwner(farm)}  ${farm.links} link(s)  ${tracks}`);
    }
    printFlights(inspection.flights);
    printPending(inspection.pending);
    console.log(`  Disk     ${formatBytes(inspection.storeBytes)}`);
    // An update keeps each old version, thus a reclaimable total shows the disk that
    // `inflexa store reclaim` frees. A zero total is the common state, and printing
    // it would be noise, so the line stays silent then.
    if (inspection.reclaimableBytes > 0) {
        console.log(`  Reclaim  ${formatBytes(inspection.reclaimableBytes)} unreferenced — run \`inflexa store reclaim\` to recover it`);
    }
    printDownload(inspection.download);
}

/** Print the acquisition flights that are live now. No flight is the common state, thus the block stays silent then. */
function printFlights(flights: readonly StoreFlightInspection[]): void {
    if (flights.length === 0) return;
    console.log(`  Flights  ${flights.length}`);
    for (const flight of flights) {
        const analyses = flight.analyses.length === 0 ? "no analysis subscribed" : `analyses: ${flight.analyses.join(", ")}`;
        console.log(`    ${flight.spec}  ${flight.state}  ${analyses}`);
    }
}

/** Print the pending adds. An empty queue is the common state, thus the block stays silent then. */
function printPending(pending: readonly StorePendingInspection[]): void {
    if (pending.length === 0) return;
    console.log(`  Queued   ${pending.length}`);
    for (const entry of pending) {
        console.log(`    ${entry.spec}  ${entry.analysis === null ? "no analysis" : `analysis "${entry.analysis}"`}`);
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

/** Whether any live store work — a flight, a pending flush — is on this machine. The reclaim reads it, and a test seeds it. */
export function storeHasLiveWork(): boolean {
    return anyLiveStoreFlight();
}
