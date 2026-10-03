/**
 * The `inflexa store` command actions — add, ls, download, cancel, reclaim —
 * and the logic of `store link`, over the host package store. Each action runs
 * in its own process with no server, thus a one-shot container can run it. The
 * lock files and the flight and transfer rows coordinate it with the local
 * server, which runs the same logic behind the store routes for the TUI.
 * `store link` is a client of the farm-link route of the server.
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
 * once, in-process. The agent route enqueues and returns, and the server
 * flushes the set at the turn end or after the 10-second gate, whichever comes
 * first.
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

import { err, ok, type Result } from "neverthrow";
import PQueue from "p-queue";
import { z } from "zod";

import { parseQuery, type PackageQuery, type ParseQueryError } from "@inflexa-ai/harness";
import { readFarmLock } from "@inflexa-ai/harness";

import { env } from "../../lib/env.ts";
import { acquireInstanceLock, liveInstanceLockHolds, releaseInstanceLock, PACKAGE_STORE_RECLAIM_LOCK_KEY, TRANSFER_LOCK_KEY_PREFIX } from "../../lib/lock.ts";
import type { IdOrName } from "../../lib/types.ts";
import { listAnalyses, listPendingStoreAdds } from "../../db/primary_query.ts";
import type { Analysis } from "../../types/analysis.ts";
import { findAnalysis } from "../analysis/analysis.ts";
import {
    describeFarmCompositionError,
    extendFarm,
    FARM_LOCK_KEY_PREFIX,
    readDepsGraph,
    identityKeySpelling,
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
    bothHitRemedy,
    describeStoreFlightSpec,
    enqueueStoreAdd,
    flushPendingStoreAdds,
    readStoreFlights,
    type FlushDeps,
    type FlushSpecOutcome,
    type StoreEnqueueError,
    type StoreFlightSpec,
} from "./store_flight.ts";
import { readTransferReport } from "./transfers.ts";
import { spawnDetachedSelf } from "./transfers.ts";
import type { StoreEcosystem, StoreFlightStatus, TransferPhase } from "../../types/store.ts";

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

/** What the pending-flush gate reads and starts, and its cadence. Tests replace each one. */
export type PendingFlushOpts = {
    /** The enqueue time of each pending add, epoch millis. */
    readonly readPending: () => readonly { readonly createdAt: number }[];
    readonly startFlush: () => number | null;
    readonly now: () => number;
    /** How often the timer of {@link watchPendingFlush} reads the pending set. */
    readonly pollMs: number;
    /** How long the oldest pending add waits before the gate starts the flush child. */
    readonly flushAfterMs: number;
};

/**
 * The production {@link PendingFlushOpts}: a read each 2 s, and a flush once the oldest add is 10 s old. The
 * turn end flushes first when it comes sooner. The bound exists for the long turn: an add approved early
 * must not wait behind minutes of agent work, because the acquisition can run beside that work.
 */
export const DEFAULT_PENDING_FLUSH_OPTS: PendingFlushOpts = {
    readPending: () => listPendingStoreAdds().unwrapOr([]),
    startFlush: startPendingFlushChild,
    now: () => Date.now(),
    pollMs: 2_000,
    flushAfterMs: 10_000,
};

/**
 * The 10-second gate of the pending set, as one step that a timer calls. A step starts the flush child when
 * the oldest pending add is `flushAfterMs` old, and then not again for `flushAfterMs`. The child claims the
 * rows, thus a second start inside that window would only meet a claimed set. A start that could not
 * spawn leaves the set as it is, and the step after the window starts it again.
 */
export function createPendingFlushGate(opts: PendingFlushOpts = DEFAULT_PENDING_FLUSH_OPTS): { step(): void } {
    let lastStart: number | null = null;
    return {
        step() {
            const pending = opts.readPending();
            if (pending.length === 0) {
                lastStart = null;
                return;
            }
            const now = opts.now();
            const oldest = pending.reduce((min, entry) => Math.min(min, entry.createdAt), Number.POSITIVE_INFINITY);
            if (now - oldest < opts.flushAfterMs) return;
            if (lastStart !== null && now - lastStart < opts.flushAfterMs) return;
            lastStart = now;
            opts.startFlush();
        },
    };
}

/**
 * Run the pending-flush gate on a timer for the life of the server, whatever client is open: an agent add
 * of the `run_inflexa` tool enqueues with `--queued`, and the tool tells the agent that the batch starts
 * within 10 seconds. Gives the stop.
 */
export function watchPendingFlush(opts: PendingFlushOpts = DEFAULT_PENDING_FLUSH_OPTS): () => void {
    const gate = createPendingFlushGate(opts);
    const timer = setInterval(() => gate.step(), opts.pollMs);
    return () => clearInterval(timer);
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

/** One failed flight as the listing reports it: the spec, and the recorded reason whole. */
export type StoreFailedFlightInspection = {
    readonly spec: string;
    /** The durable reason: the phase, then the whole error text. The printer renders a short head of it. */
    readonly message: string;
};

/** One pending add of the queue, as the listing reports it. */
export type StorePendingInspection = {
    readonly spec: string;
    readonly analysis: string | null;
};

/** What the inspection reports about the catalog transfer. */
export type StoreDownloadInspection = {
    /** When the last write of the transfer row landed, epoch millis. Zero when no download ran. */
    readonly updatedAt: number;
    /** The lifecycle state the reader acts on, or `null` when no download ran. */
    readonly state: "pending" | "running" | "installed" | "failed" | "declined" | "canceled" | null;
    /** The bytes the transfer has moved. */
    readonly bytesTransferred: number;
    /** The bytes the manifest declares, or `null` before the manifest resolves. */
    readonly totalBytes: number | null;
    /** The part of the work the child does now, or `null` when the row declares none. */
    readonly phase: TransferPhase | null;
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
    /** The failed flights, each with its durable reason. Empty is the common state. */
    readonly failed: readonly StoreFailedFlightInspection[];
    /** The enqueued adds that no flush took yet. Empty is the common state. */
    readonly pending: readonly StorePendingInspection[];
    /** Bytes the deduplicated store content occupies (`store/` only — the farms are symlinks). */
    readonly storeBytes: number;
    /**
     * Bytes held by store content that no farm links and the graph does not advertise — the space
     * `inflexa store reclaim` would recover. An update adds only the content whose hash changed and it
     * removes nothing, but it replaces the graph whole, thus an old version loses its node and counts
     * here until a reclaim runs.
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
        const { flights, failed } = readFlightInspections();
        const pending = readPendingInspections();
        if (!existsSync(storeRoot)) {
            return ok({ root: storeRoot, exists: false, packages: [], farms: [], flights, failed, pending, storeBytes: 0, reclaimableBytes: 0, download });
        }
        const packages = await readStorePackages(storeRoot);
        const farms = await readFarms(storeRoot);
        const storeBytes = await dirBytes(join(storeRoot, "store"));
        const reclaimableBytes = await reclaimableStoreBytes(storeRoot);
        return ok({ root: storeRoot, exists: true, packages, farms, flights, failed, pending, storeBytes, reclaimableBytes, download });
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

/** The flight rows split for the listing: the live flights with their subscribers, and the failed records with their reasons. */
function readFlightInspections(): { flights: readonly StoreFlightInspection[]; failed: readonly StoreFailedFlightInspection[] } {
    const rows = readStoreFlights();
    if (rows.length === 0) return { flights: [], failed: [] };
    const names = analysisNamesById();
    const flights: StoreFlightInspection[] = [];
    const failed: StoreFailedFlightInspection[] = [];
    for (const flight of rows) {
        if (flight.row.state === "failed") {
            failed.push({ spec: describeStoreFlightSpec(flight.row), message: flight.row.message ?? "no reason was recorded" });
            continue;
        }
        flights.push({
            spec: describeStoreFlightSpec(flight.row),
            state: flight.row.state,
            analyses: flight.analysisIds.map((id) => names.get(id) ?? id),
        });
    }
    return { flights, failed };
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
        updatedAt: report.row?.updatedAt ?? 0,
        state: report.state,
        bytesTransferred: report.row?.bytesTransferred ?? 0,
        totalBytes: report.row?.totalBytes ?? null,
        phase: report.row?.phase ?? null,
        message: report.row?.message ?? null,
        updateAvailable: installed !== null && latest !== null && installed !== latest,
    };
}

// --- host reads ---------------------------------------------------------------

/**
 * The store directories the dependency graph advertises, read LENIENTLY. The
 * reclaim rule must hold even over a graph the strict reader refuses (a
 * dangling edge), because "advertised" is a node-set question, and the node
 * set of a damaged graph still answers it. `null` means the file exists and
 * does not parse — the advertised set is then unknown, and a caller must
 * reclaim NOTHING rather than everything. An absent file advertises nothing,
 * because a store with no graph holds only leftovers.
 */
async function advertisedStoreDirs(storeRoot: string): Promise<ReadonlySet<string> | null> {
    const path = join(storeRoot, "deps.json");
    if (!existsSync(path)) return new Set();
    try {
        const parsed = JSON.parseWith(await readFile(path, "utf8"), z.object({ nodes: z.record(z.string(), z.unknown()).default({}) }).passthrough());
        return parsed === null ? null : new Set(Object.keys(parsed.nodes));
    } catch {
        return null;
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

/** How many `readdir` and `lstat` calls {@link dirBytes} keeps in flight at one time. */
const DIR_WALK_WIDTH = 16;

/**
 * Sum the bytes of the real files under a directory, or 0 when it is absent. Never follows a symlink,
 * so a farm's links add nothing and a loop cannot form. `lstatFile` reads the size of one file.
 */
export async function dirBytes(dir: string, lstatFile: (path: string) => Promise<{ readonly size: number }> = lstat): Promise<number> {
    if (!existsSync(dir)) return 0;
    const queue = new PQueue({ concurrency: DIR_WALK_WIDTH });
    let total = 0;
    // The priority is the depth, so deeper work runs first and the walk drains one subtree before it
    // opens the next. The queue then holds about one listing for each level, as a recursive walk does,
    // and not the whole frontier of the tree.
    async function walk(path: string, depth: number): Promise<void> {
        const entries = await queue.add(() => readdir(path, { withFileTypes: true }), { priority: depth });
        await Promise.all(
            entries.map(async (entry) => {
                const full = join(path, entry.name);
                if (entry.isSymbolicLink()) return;
                if (entry.isDirectory()) return walk(full, depth + 1);
                if (!entry.isFile()) return;
                const size = await queue.add(
                    async () => {
                        try {
                            return (await lstatFile(full)).size;
                        } catch {
                            // A file that vanished mid-walk contributes nothing.
                            return 0;
                        }
                    },
                    { priority: depth + 1 },
                );
                // Added after the await: `total += await …` reads `total` before it, and loses the sums of the concurrent reads.
                total += size;
            }),
        );
    }
    await walk(dir, 0);
    return total;
}

/**
 * Bytes held by store directories that no farm links AND the graph does not
 * advertise — the space `inflexa store reclaim` would recover. It reuses the
 * two set scans the reclaim uses ({@link referencedStoreDirs},
 * {@link advertisedStoreDirs}), so the readout and the removal agree. An
 * unparsable graph reads as zero, because the removal then removes nothing.
 */
async function reclaimableStoreBytes(storeRoot: string): Promise<number> {
    const storeDir = join(storeRoot, "store");
    if (!existsSync(storeDir)) return 0;
    const advertised = await advertisedStoreDirs(storeRoot);
    if (advertised === null) return 0;
    const referenced = await referencedStoreDirs(storeRoot);
    let total = 0;
    for (const entry of await readdir(storeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || referenced.has(entry.name) || advertised.has(entry.name)) continue;
        total += await dirBytes(join(storeDir, entry.name));
    }
    return total;
}

// --- The reclamation -----------------------------------------------------------

/**
 * The store directories that no farm links AND the graph does not advertise —
 * the set reclamation would remove. Computed on the host so a command can
 * report it before removing anything. This mirrors the provisioner's own
 * referenced-set scan, so the preview and the removal agree unless a
 * concurrent run changes the store between them. A graph-advertised directory
 * is pool inventory, not waste: a locally acquired package holds no farm link
 * until a run links it, and an edge of a surviving node must never dangle.
 */
export async function reclaimPreview(storeRoot: string): Promise<Result<readonly string[], StoreActionError>> {
    try {
        const storeDir = join(storeRoot, "store");
        if (!existsSync(storeDir)) return ok([]);
        // An unparsable graph makes the advertised set unknown, thus the
        // preview is empty: a removal over an unknown set deletes inventory.
        const advertised = await advertisedStoreDirs(storeRoot);
        if (advertised === null) return ok([]);
        const referenced = await referencedStoreDirs(storeRoot);
        const entries = await readdir(storeDir, { withFileTypes: true });
        const unreferenced = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
            .map((entry) => entry.name)
            .filter((name) => !referenced.has(name) && !advertised.has(name))
            .sort((a, b) => a.localeCompare(b));
        return ok(unreferenced);
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
    }
}

/**
 * Remove store content that no farm links and the graph does not advertise,
 * EXCLUSIVELY against the acquisition flights and against the farm
 * compositions.
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
        // A `failed` row is a terminal record, not live work: it references
        // nothing, it never advances, and a wait on it would never end.
        const flights = readStoreFlights().filter((flight) => flight.row.state !== "failed");
        const compositions = liveInstanceLockHolds(FARM_LOCK_KEY_PREFIX);
        if (flights.length === 0 && compositions.length === 0) return ok(undefined);
        if (waited >= waitMs) {
            if (flights.length > 0) {
                const names = flights.map((flight) => `${flight.row.spelling}${flight.row.specifier}`).join(", ");
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

// --- The debris collection ------------------------------------------------------

/** What one silent debris pass did. `swept: false` is the yield: live work, a held lock, or nothing to free. */
export type DebrisSweepOutcome = {
    readonly swept: boolean;
    /** The store directories the pass removed. */
    readonly dirs: readonly string[];
    /** How many stale acquire reports the pass removed. */
    readonly reports: number;
};

/** The seams of a debris pass. Production passes none; a test pins the runner. */
export type DebrisDeps = {
    readonly run?: ProvisionerRunner;
    readonly onProgress?: (line: string) => void;
};

/**
 * Collect the debris tier silently: the store directories with no farm link
 * and no graph node, plus the stale acquire reports. No user command starts
 * this — the tail of a flush that ended with refusals and the one boot pass
 * of the app call it, and `store reclaim` keeps its meaning and its approval
 * gate.
 *
 * The pass YIELDS to live work, and it never waits: a held reclaim lock, a
 * live flight, a live composition, or a live transfer each end it at once
 * with `swept: false`. A live sandbox run needs no check of its own, because
 * a run reaches store content only through the links of its farm, and a
 * linked directory is never debris. The container starts only when the
 * preview names something, thus a quiet pass costs no engine start.
 */
export async function collectStoreDebris(storeRoot: string, deps: DebrisDeps = {}): Promise<Result<DebrisSweepOutcome, StoreActionError>> {
    // One pass per process, and a second caller JOINS the live one. The
    // reclaim lock is re-entrant for one pid, thus a second in-process entry
    // would pass the acquire, run beside the first, and free the lock under
    // it — a waiter in another process then reads a live reclamation as gone.
    if (debrisInflight !== null) return debrisInflight;
    debrisInflight = runDebrisPass(storeRoot, deps);
    try {
        return await debrisInflight;
    } finally {
        debrisInflight = null;
    }
}

/** The live debris pass of this process, while one runs. */
let debrisInflight: Promise<Result<DebrisSweepOutcome, StoreActionError>> | null = null;

async function runDebrisPass(storeRoot: string, deps: DebrisDeps): Promise<Result<DebrisSweepOutcome, StoreActionError>> {
    const lock = acquireInstanceLock(PACKAGE_STORE_RECLAIM_LOCK_KEY);
    if (!lock.acquired) return ok({ swept: false, dirs: [], reports: 0 });
    try {
        const liveFlight = readStoreFlights().some((flight) => flight.row.state !== "failed");
        if (liveFlight || liveInstanceLockHolds(FARM_LOCK_KEY_PREFIX).length > 0 || liveInstanceLockHolds(TRANSFER_LOCK_KEY_PREFIX).length > 0) {
            return ok({ swept: false, dirs: [], reports: 0 });
        }
        const preview = await debrisPreview(storeRoot);
        if (preview.isErr()) return err(preview.error);
        const { dirs, reports } = preview.value;
        if (dirs.length === 0 && reports === 0) return ok({ swept: false, dirs: [], reports: 0 });
        const run = deps.run ?? runProvisioner;
        const ran = await run({ storeRoot, egressAllow: null, args: ["reclaim", "--debris"] }, (line) => deps.onProgress?.(line));
        if (ran.isErr()) return err(ran.error);
        return classifyProvisionerRun(ran.value).map(() => ({ swept: true, dirs, reports }));
    } finally {
        releaseInstanceLock(PACKAGE_STORE_RECLAIM_LOCK_KEY);
    }
}

/**
 * The debris tier as the host previews it: the directories with no farm link
 * and no graph node, plus the count of the stale acquire reports. An
 * unreadable or absent graph names NO directory, because the pass cannot then
 * prove that a directory is unadvertised — the conservative branch frees
 * nothing.
 */
async function debrisPreview(storeRoot: string): Promise<Result<{ dirs: readonly string[]; reports: number }, StoreActionError>> {
    try {
        const storeDir = join(storeRoot, "store");
        const dirs: string[] = [];
        if (existsSync(storeDir)) {
            const advertised = readDepsGraph(storeRoot).match(
                (graph) => new Set(graph.nodes.keys()),
                () => null,
            );
            if (advertised !== null) {
                const referenced = await referencedStoreDirs(storeRoot);
                for (const entry of await readdir(storeDir, { withFileTypes: true })) {
                    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
                    if (!referenced.has(entry.name) && !advertised.has(entry.name)) dirs.push(entry.name);
                }
            }
        }
        const downloadDir = join(storeRoot, ".inflexa-download");
        const reports = existsSync(downloadDir)
            ? (await readdir(downloadDir)).filter((name) => name.startsWith("acquire-") && name.endsWith(".json")).length
            : 0;
        return ok({ dirs: dirs.sort((a, b) => a.localeCompare(b)), reports });
    } catch (cause) {
        return err({ type: "io_failed", message: `Could not inspect the package store at ${storeRoot}.`, cause });
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

/** The analysis that a farm-bearing reference names, resolved in ONE query and id first. */
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

/**
 * One line that names why a command argument is not a package query, with the
 * remedy of the command surface.
 *
 * An unknown prefix does NOT read as a grammar fault here. The two commands
 * carry `--lang`, and the command spec keeps a prefix off the command surface,
 * thus the flag is the one remedy that this surface can offer.
 */
function describeCommandParseError(error: ParseQueryError): string {
    switch (error.type) {
        case "empty":
            return "A package argument is empty. Write one package name, with `==<version>` for one exact version.";
        case "location":
            return `"${error.entry}" is a path or a URL, and the package store answers names. Write the package name instead.`;
        case "unknown_prefix":
            return (
                `"${error.entry}" carries the unknown prefix "${error.prefix}:". Write the package name alone, ` +
                "and name the ecosystem with `--lang python` or `--lang r`."
            );
        case "unsupported_specifier":
            return `"${error.entry}" carries the specifier "${error.specifier}". The store pins one exact version only — write \`<name>==<version>\`.`;
        default: {
            // The union is closed, thus the compiler proves that this is unreachable.
            const unreachable: never = error;
            throw new Error(`unhandled package query parse error: ${JSON.stringify(unreachable)}`);
        }
    }
}

/**
 * The query that one command argument asks, or the refusal that names the
 * remedy. `store add` and `store link` share it, thus one argument reaches one
 * query by one grammar.
 *
 * A prefix inside the argument REFUSES. The command surface names an ecosystem
 * with `--lang`, and two ways to say one thing is what lets a flag and an
 * argument disagree — the command spec keeps the prefix out.
 */
function commandQuery(entry: string): Result<PackageQuery, { readonly message: string }> {
    return parseQuery(entry)
        .mapErr((error) => ({ message: describeCommandParseError(error) }))
        .andThen((query) =>
            query.track === undefined
                ? ok<PackageQuery, { readonly message: string }>(query)
                : err<PackageQuery, { readonly message: string }>({
                      message:
                          `"${entry.trim()}" names its ecosystem with the prefix "${query.track}:". ` +
                          `Write \`${query.spelling}\` with \`--lang ${query.track}\` instead.`,
                  }),
        );
}

/**
 * Merge the flags of a command into the query of its argument.
 *
 * A version in the argument and a `--version` that name two versions refuse:
 * one call asks for one version, and a silent pick between the two would
 * install what the caller did not name. `--lang` cannot disagree, because a
 * prefix never reaches here.
 */
function mergeCommandFlags(
    query: PackageQuery,
    flags: { readonly version: string | null; readonly lang: StoreEcosystem | null },
): Result<PackageQuery, { readonly message: string }> {
    const flagVersion = flags.version === null ? undefined : flags.version.trim();
    if (flagVersion !== undefined && query.version !== undefined && query.version !== flagVersion) {
        return err({
            message: `"${query.spelling}==${query.version}" and \`--version ${flagVersion}\` name two versions. Name one version, in the argument or in the flag.`,
        });
    }
    const version = query.version ?? flagVersion;
    return ok({
        spelling: query.spelling,
        ...(flags.lang === null ? {} : { track: flags.lang }),
        ...(version === undefined ? {} : { version }),
    });
}

/** The flags of `inflexa store add` that shape the add. */
export type StoreAddOptions = {
    /** One exact version, or `null` for the newest the index serves. */
    readonly version: string | null;
    /** The ecosystem, or `null` for a name the acquire run resolves. */
    readonly lang: StoreEcosystem | null;
    /** The analysis whose farm the add extends after the commit. */
    readonly analysis: IdOrName | null;
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
            const pair = bothHitRemedy(outcome.candidates);
            reportError({
                message:
                    `Both ecosystems hold "${outcome.spec.spelling}". Nothing was installed. ` +
                    `Run \`inflexa store add ${outcome.spec.spelling}\` again with ${pair} to name the one you want.`,
            });
            return;
        }
        default: {
            const unreachable: never = outcome;
            throw new Error(`unhandled flush outcome: ${JSON.stringify(unreachable)}`);
        }
    }
}

/**
 * Run one flush and print its outcomes, sharing the shape between the terminal
 * add and the flush child. The tail of a flush that ended with refusals runs
 * the silent debris pass. Exported for the test of exactly that trigger; the
 * command routes pass no `deps`, thus production runs the real seams.
 */
export async function flushAndPrint(storeRoot: string, deps: { readonly flush?: FlushDeps; readonly debris?: DebrisDeps } = {}): Promise<void> {
    const flushed = await flushPendingStoreAdds(storeRoot, { onProgress: (line) => console.log(line), ...deps.flush });
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
    // The silent tail: a flush that ended with refusals — a whole-run error
    // refuses everything — left never-advertised bytes, and the pass frees
    // them at once. It yields when any other work is live, thus a live
    // sibling flight keeps its staged directories.
    const refused = flushed.match(
        (result) => result.type === "flew" && result.outcomes.some((outcome) => outcome.kind === "refused"),
        () => true,
    );
    if (!refused) return;
    const collected = await collectStoreDebris(storeRoot, deps.debris ?? {});
    collected.match(
        (outcome) => {
            if (outcome.swept)
                console.log(`Removed ${outcome.dirs.length} debris director${outcome.dirs.length === 1 ? "y" : "ies"} and ${outcome.reports} stale report(s).`);
        },
        () => undefined,
    );
}

/** Why one add did not enter the pending set. Each variant is one message that names the remedy. */
export type StoreAddRefusal =
    | { readonly type: "invalid_package"; readonly message: string }
    | FarmAnalysisError
    | StoreEnqueueError
    | { readonly type: "store_root_failed"; readonly message: string; readonly cause: unknown };

/**
 * Enqueue ONE package into the pending set of the content-addressed pool, the
 * body of `inflexa store add`. The flush is a different step: the agent route
 * (`--queued`) leaves it to the turn end or to the 10-second gate, and a
 * direct add flushes at once.
 */
export function queueStoreAdd(pkg: string, options: StoreAddOptions): Result<StoreFlightSpec, StoreAddRefusal> {
    if (pkg.trim() === "") {
        return err({
            type: "invalid_package",
            message: "`inflexa store add` takes exactly one package. Write `inflexa store add <name>`, with `--version <v>` for one exact version.",
        });
    }
    // One package per call is the rule of the command surface. A second name
    // would ride the version flag or the argument list, and commander already
    // refuses extra arguments — this refusal covers the embedded-space form.
    if (/\s/.test(pkg.trim())) {
        return err({ type: "invalid_package", message: "`inflexa store add` takes exactly one package per call. Run the command once per package." });
    }

    let analysisId: string | null = null;
    if (options.analysis !== null) {
        const target = resolveFarmAnalysis(options.analysis);
        if (target.isErr()) return err(target.error);
        analysisId = target.value.id;
    }

    const asked = commandQuery(pkg).andThen((query) => mergeCommandFlags(query, { version: options.version, lang: options.lang }));
    if (asked.isErr()) return err({ type: "invalid_package", message: asked.error.message });
    return enqueueStoreAdd({ query: asked.value, analysisId });
}

/** Make the store root, so that the flush of a direct add has a root to bind. */
function ensureStoreRoot(storeRoot: string): Result<void, StoreAddRefusal> {
    try {
        mkdirSync(storeRoot, { recursive: true });
        return ok(undefined);
    } catch (cause) {
        return err({
            type: "store_root_failed",
            message: `Could not create the package store at ${storeRoot} (${cause instanceof Error ? cause.message : String(cause)}).`,
            cause,
        });
    }
}

/**
 * `inflexa store add` — acquire ONE package into the content-addressed pool.
 *
 * The add ENQUEUES into the pending set. The agent route (`queued`) returns at
 * once, thus the ask tool answers fast — the server flushes the set at the
 * turn end or after the 10-second gate. A direct terminal add flushes at once,
 * in-process, and streams the provisioner output.
 */
export async function runStoreAdd(pkg: string | undefined, options: StoreAddOptions & { readonly queued: boolean }): Promise<void> {
    const enqueued = queueStoreAdd(pkg ?? "", options);
    if (enqueued.isErr()) {
        reportError(enqueued.error);
        return;
    }

    if (options.queued) {
        console.log(`Queued ${describeStoreFlightSpec(enqueued.value)} for acquisition. The flight starts at the turn end, or after at most 10 seconds.`);
        console.log("Run `inflexa store ls` to see the queue and the flights.");
        return;
    }

    // The direct terminal add is the explicit flush: the batch is whatever the
    // pending set holds now, including adds that other approvals enqueued.
    const storeRoot = env.packageStoreDir;
    const root = ensureStoreRoot(storeRoot);
    if (root.isErr()) {
        reportError(root.error);
        return;
    }
    console.log("Acquiring into the package pool (network on, egress allowlisted). This can take some minutes.");
    await flushAndPrint(storeRoot);
}

/** Why a link call changed no farm. `refused` holds one refusal for each package that the pool cannot answer. */
export type FarmLinkError =
    | { readonly type: "refused"; readonly message: string }
    | { readonly type: "graph_unreadable"; readonly message: string }
    | { readonly type: "farm_not_extended"; readonly message: string };

/**
 * Link packages that the pool holds into the farm of one analysis: the body of
 * the farm-link route of the server, which `inflexa store link` calls.
 *
 * It ACQUIRES nothing. It starts no container, it opens no network connection:
 * it reads the dependency graph, it resolves each requirement against the
 * pool, and it writes symbolic links. An acquisition is `inflexa store add`,
 * which takes minutes and holds the network open, and that difference is why
 * the two are two commands and not one command with a flag.
 *
 * The whole request set resolves BEFORE one link is written. Thus a call that
 * names a package the pool does not hold reports each refusal at one time, and
 * the farm stays exactly as it was. A both-hit refuses with the two candidates
 * and the `--lang` remedy.
 */
export async function linkIntoAnalysisFarm(
    storeRoot: string,
    analysis: Pick<Analysis, "id" | "name">,
    packages: readonly string[],
    lang: StoreEcosystem | null,
): Promise<Result<{ readonly linked: readonly string[]; readonly storeDirs: number }, FarmLinkError>> {
    const graph = readDepsGraph(storeRoot);
    if (graph.isErr()) {
        return err({ type: "graph_unreadable", message: `Could not read what the package pool holds: ${describeFarmCompositionError(graph.error)}.` });
    }

    // Each answer keeps the spelling of its query. The Python shelf of the graph
    // speaks the fold, and an R name is case- and dot-sensitive, thus every
    // render below echoes the spelling — the rule of the mgmt spec.
    const resolved: { readonly answer: ResolvedRequest; readonly spelling: string }[] = [];
    const refusals: string[] = [];
    for (const requirement of packages) {
        const asked = commandQuery(requirement).andThen((parsed) => mergeCommandFlags(parsed, { version: null, lang }));
        if (asked.isErr()) {
            refusals.push(asked.error.message);
            continue;
        }
        const query = asked.value;
        const answer = resolvePackageRequest(graph.value, query);
        if (answer.isOk()) {
            resolved.push({ answer: answer.value, spelling: query.spelling });
            continue;
        }
        refusals.push(describeRequestRefusal(answer.error, query));
    }
    if (refusals.length > 0) return err({ type: "refused", message: refusals.join("\n\n  ") });

    const extended = await extendFarm({ storeRoot, analysisId: analysis.id, roots: resolved.map((item) => item.answer.storeDir) });
    return extended
        .map((composition) => ({ linked: resolved.map((item) => `${item.spelling}==${item.answer.version}`), storeDirs: composition.storeDirs.length }))
        .mapErr((error): FarmLinkError => ({
            type: "farm_not_extended",
            message: `The farm of "${analysis.name}" was not extended: ${describeFarmCompositionError(error)}.`,
        }));
}

/**
 * One refusal that a person, or an agent, can act on. A bare "not found" is
 * what sends a caller around the same loop for ever, thus each message names
 * the remedy.
 *
 * The query carries the spelling of the request, and each render echoes it.
 * The suggestion of the error is an identity KEY, and a remedy in that form
 * breaks: `store add r:Seurat` refuses at this surface, thus the render quotes
 * the spelling that the key holds. Exported for the test that pins the echo
 * rule.
 */
export function describeRequestRefusal(error: RequestResolutionError, query: PackageQuery): string {
    switch (error.type) {
        case "unknown_distribution": {
            // The suggestion comes BEFORE the ask: the pool holds the package
            // under that spelling, thus an acquisition would be needless work.
            const ask = `Run \`inflexa store add ${query.spelling}\` to acquire it — the acquisition covers PyPI, CRAN, and Bioconductor.`;
            return error.suggestion === undefined
                ? `The package pool holds nothing named "${query.spelling}". ${ask}`
                : `The package pool holds nothing named "${query.spelling}". It holds "${identityKeySpelling(error.suggestion)}", ` +
                      `and an R package name is case-sensitive — link that spelling instead. ${ask}`;
        }
        case "unknown_version":
            return (
                `The package pool holds no version ${error.version} of "${query.spelling}". It holds ${error.available.join(", ")}. ` +
                `Link one of those versions, or run \`inflexa store add ${query.spelling} --version ${error.version}\` to acquire the one you named.`
            );
        case "ambiguous_ecosystem":
            return (
                `Both ecosystems hold "${query.spelling}" (${error.candidates.join(" and ")}), and the request names none. ` +
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
export async function runStoreDownload(
    options: { update?: boolean; foreground?: boolean },
    deps: { transfer?: (params: { storeRoot: string; update: boolean }) => Promise<void> } = {},
): Promise<void> {
    const storeRoot = env.packageStoreDir;
    if (options.foreground === true) {
        // The foreground mode exists for a one-shot container: the pod lives as
        // long as this process, and the exit code is the one signal it reports.
        // A live detached transfer refuses the run, because the lock would turn
        // the second run into a silent no-op — and a silent no-op reads as success.
        const live = readTransferReport("catalog");
        if (live.live) {
            reportError({ message: `A package-store download is already running (pid ${live.holderPid ?? "unknown"}). A foreground run must not race it.` });
            return;
        }
        await (deps.transfer ?? runCatalogTransfer)({ storeRoot, update: options.update ?? false });
        const settled = readTransferReport("catalog");
        if (settled.state === "installed") {
            console.log("The catalog transfer settled as installed.");
            return;
        }
        reportError({ message: `The catalog transfer settled as ${settled.state ?? "unknown"}${settled.row?.message ? `: ${settled.row.message}` : ""}` });
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
    if (outcome.type === "timed_out") {
        console.log(`The download child (pid ${outcome.holderPid}) did not stop inside the wait. Nothing was removed.`);
        console.log("The child drains its shutdown. Run `inflexa store cancel` again in a moment.");
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
 * `inflexa store reclaim` — report, then remove, store content that no farm
 * links and the graph does not advertise. The report comes from `onPreview`,
 * thus it lands INSIDE the exclusivity window that `reclaimStore` holds.
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
        case "running": {
            // The catalog child unpacks the layers after the last byte, thus the byte
            // meter stops at the total while the work continues. The age of the last
            // write is the proof of motion. A terminal state names its own failure,
            // thus only a live state carries the phase.
            const phase = download.phase === "unpacking" ? ` — unpacking · active ${Date.relativeAge(download.updatedAt)}` : "";
            console.log(`  Download running — ${describeTransfer(download.bytesTransferred, download.totalBytes)}${phase}`);
            break;
        }
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
        printFailedFlights(inspection.failed);
        printPending(inspection.pending);
        printDownload(inspection.download);
        return;
    }
    console.log(`  Packages ${inspection.packages.length}`);
    const pinCounts = new Map<string, number>();
    for (const pkg of inspection.packages) if (pkg.pin !== null) pinCounts.set(pkg.pin, (pinCounts.get(pkg.pin) ?? 0) + 1);
    for (const pkg of inspection.packages) {
        // Two store directories can hold one pin, for example the build of an older catalog that a farm
        // still links. Only the directory tells the two lines apart.
        const shared = pkg.pin !== null && (pinCounts.get(pkg.pin) ?? 0) > 1;
        console.log(`    ${pkg.pin ?? pkg.dir}${shared ? `  ${pkg.dir}` : ""}`);
    }
    console.log(`  Farms    ${inspection.farms.length}`);
    for (const farm of inspection.farms) {
        const tracks = farm.tracks.length === 0 ? "no lock" : `tracks: ${farm.tracks.join(", ")}`;
        console.log(`    ${farm.name}  ${describeFarmOwner(farm)}  ${farm.links} link(s)  ${tracks}`);
    }
    printFlights(inspection.flights);
    printFailedFlights(inspection.failed);
    printPending(inspection.pending);
    console.log(`  Disk     ${formatBytes(inspection.storeBytes)}`);
    // The total counts only the debris tier: no farm link AND no graph node.
    // A graph-advertised package with no farm link yet is inventory, and the
    // hint must never point a reader at removing it. A zero total is the
    // common state, and printing it would be noise, so the line stays silent.
    if (inspection.reclaimableBytes > 0) {
        console.log(`  Reclaim  ${formatBytes(inspection.reclaimableBytes)} of debris — run \`inflexa store reclaim\` to recover it`);
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

/** How much of a recorded failure reason one listing line carries. The row keeps the whole text. */
const FAILURE_HEAD_CHARS = 120;

/** The first line of a recorded reason, clamped — the render is bounded here, and never at record time. */
function reasonHead(message: string): string {
    const first = message.split("\n", 1)[0] ?? message;
    return first.length <= FAILURE_HEAD_CHARS ? first : `${first.slice(0, FAILURE_HEAD_CHARS)}…`;
}

/**
 * Print the failed flights with a short head of each reason. No failure is
 * the common state, thus the block stays silent then. The retry remedy rides
 * the block once, not each line.
 */
function printFailedFlights(failed: readonly StoreFailedFlightInspection[]): void {
    if (failed.length === 0) return;
    console.log(`  Failed   ${failed.length}`);
    for (const flight of failed) console.log(`    ${flight.spec}  ${reasonHead(flight.message)}`);
    console.log("    A new `inflexa store add` of the same package clears its failure.");
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
