/**
 * The acquisition flights of `inflexa store add`, and the pending set that
 * batches them.
 *
 * An approved `store add` ENQUEUES into the pending set and starts no
 * provisioner run of its own. The FLUSH takes the whole set into one one-shot
 * `acquire` run: the chat flushes when the asks of the agent turn settle, and a
 * direct terminal add flushes at once. Thus three approvals of one turn share
 * one provisioner container, and the store lock sees one writer per batch.
 *
 * A flight is the record of acquiring ONE normalized spec. The key of a flight
 * is that spec: the ecosystem (or none, for a name the run resolves), the
 * PEP 503 canonical name, and the specifier. One flight lives for each key,
 * thus a spec that another process already acquires starts no second run — the
 * flush subscribes its analysis to the live flight and drops the spec from its
 * own batch. A flight row also carries the liveness of the batch through its
 * `holder_pid`, and the reclamation waits on exactly that.
 *
 * The flight is TWO-PHASE (the package-store-management spec). Phase one: the
 * provisioner acquires the set into the pool and stages the graph nodes as one
 * report file — `deps.json` stays untouched. Phase two: the load check of the
 * acquired set runs inside the SANDBOX image, and only a green check appends
 * the staged nodes to the graph under the metadata lock. A failed check leaves
 * no advertised state: no graph node, and no farm link. The refusal settles as
 * a terminal `failed` flight row with the whole reason, and the silent debris
 * pass frees the orphaned bytes.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { randomUUIDv7 } from "bun";
import { err, ok, type Result } from "neverthrow";
import { z } from "zod";

import { readConfig } from "../../lib/config.ts";
import { readFileResult } from "../../lib/fs.ts";
import { instanceLockHolder, isPidAlive, PACKAGE_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import type { DbError } from "../../db/errors.ts";
import { countStoreFlightSubscribers, listPendingStoreAdds, listStoreFlights, type PendingStoreAdd } from "../../db/primary_query.ts";
import {
    claimPendingStoreAdds,
    claimStoreFlight,
    deleteStoreFlight,
    enqueuePendingStoreAdd,
    promoteStoreFlightBatch,
    recordStoreFlightProgress,
    settleStoreFlightFailure,
    subscribeStoreFlight,
} from "../../db/primary_mutation.ts";
import { analysisFarmPath, canonicalDistributionName, extendFarm, describeFarmCompositionError } from "./composition.ts";
import {
    ACQUIRE_EGRESS_ALLOW,
    classifyProvisionerRun,
    runLoadCheck,
    runProvisioner,
    type LoadCheckRunner,
    type ProvisionerError,
    type ProvisionerRunner,
} from "./provisioner.ts";
import { withStoreMetadataMutex } from "./store_download.ts";
import { readTransferReport } from "./transfers.ts";

/** The package ecosystems a flight can acquire. The store carries the two tracks, and the key separates them. */
export type StoreEcosystem = "python" | "r";

/**
 * The states of one flight. `queued` is a flight that owns its key and waits
 * for a slot under the concurrency cap. `running` is a flight whose batch
 * container is up. `failed` is the ONE terminal state: a refused spec settles
 * into it with a durable message, and a retry of the same spec claims the row
 * back to `queued`. A success still removes its row — a completed state that
 * everyone has is noise.
 */
export type StoreFlightStatus = "queued" | "running" | "failed";

/**
 * The normalized spec that keys a flight.
 *
 * `name` is PEP 503 canonical, thus `Scanpy`, `scan_py`, and `scan.py` all key
 * one flight. `specifier` is the exact-version constraint (`==<v>`), or empty.
 * `ecosystem` is `null` for a name the acquire run resolves — a name that both
 * ecosystems satisfy then stops with the both-hit ask.
 */
export type StoreFlightSpec = {
    readonly ecosystem: StoreEcosystem | null;
    readonly name: string;
    readonly specifier: string;
};

/**
 * The persisted row of one live flight.
 *
 * The shape lives beside the flight rather than in `src/types/`, because the
 * flight is its one consumer. `src/db/` takes it as a type-only import, thus
 * the storage layer keeps no runtime dependency on this module.
 */
export type StoreFlightRow = {
    /** The flight key: the ecosystem, the canonical name, and the specifier, joined. */
    readonly id: string;
    /** When the owner claimed the key, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The live state. */
    readonly state: StoreFlightStatus;
    /** The ecosystem of the spec, or `null` for a name the run resolves. */
    readonly ecosystem: StoreEcosystem | null;
    /** The PEP 503 canonical distribution name. */
    readonly name: string;
    /** The exact-version specifier, or empty. */
    readonly specifier: string;
    /** The newest provisioner line, or `null` before the container writes one. */
    readonly progress: string | null;
    /** The recorded reason of a `failed` flight: the phase, then the whole error text. `null` on a live row. */
    readonly message: string | null;
    /**
     * The process that owns the flight. A live row whose holder is dead is
     * debris that the next read sweeps. A `failed` row keeps the pid of its
     * ended flush, and the sweep keeps the row — the record must survive the
     * process.
     */
    readonly holderPid: number;
};

/** One live flight as a reader sees it: the row, and the analyses subscribed to it. */
export type StoreFlightReport = {
    readonly row: StoreFlightRow;
    /** The analyses subscribed. A subscription that belongs to no analysis contributes no id. */
    readonly analysisIds: readonly string[];
};

/** How many acquire runs go at one time when the configuration names no cap. */
export const DEFAULT_FLIGHT_CONCURRENCY = 2;

/** How long one wait step is: a queued batch asks for a slot again at this cadence. */
const FLIGHT_POLL_MS = 250;

/** How long a new batch waits for a live reclamation to finish before it refuses. */
const RECLAIM_WAIT_MS = 120_000;

/** How often a live batch writes its newest provisioner line, so a chatty container costs one row write per step. */
const PROGRESS_WRITE_INTERVAL_MS = 500;

/** The key of a flight: the ecosystem (or `any`), the canonical name, and the specifier, joined with `::`. */
export function storeFlightKey(spec: StoreFlightSpec): string {
    return `${spec.ecosystem ?? "any"}::${spec.name}::${spec.specifier}`;
}

/** The spec as a user reads it: the requirement, with the ecosystem behind it when one was named. */
export function describeStoreFlightSpec(spec: Pick<StoreFlightSpec, "ecosystem" | "name" | "specifier">): string {
    return `${spec.name}${spec.specifier}${spec.ecosystem === null ? "" : ` (${spec.ecosystem})`}`;
}

/** The spec in the internal format of the provisioner: an ecosystem prefix when one is known, bare otherwise. */
function provisionerSpec(spec: Pick<StoreFlightSpec, "ecosystem" | "name" | "specifier">): string {
    const requirement = `${spec.name}${spec.specifier}`;
    return spec.ecosystem === null ? requirement : `${spec.ecosystem}:${requirement}`;
}

/** The configured concurrency cap, or the default when the configuration names none. */
export function storeFlightConcurrency(): number {
    return readConfig().store?.flightConcurrency ?? DEFAULT_FLIGHT_CONCURRENCY;
}

/**
 * Remove each live flight row whose owner is gone, then report the rows that
 * remain: the live flights, and the terminal `failed` records.
 *
 * A killed owner writes no ending, thus its live row would dedup every later request for that spec
 * against work that stopped. The sweep is what makes the pid column a liveness signal rather than a
 * claim, and it runs before every read and before every claim. A `failed` row is exempt: its holder
 * ended by design, and the row is the one durable copy of the refusal.
 *
 * A read failure degrades to an empty list rather than an error. The database is a file on the
 * machine of the user, and a store that a reader cannot describe is still a store that works.
 */
export function readStoreFlights(): readonly StoreFlightReport[] {
    const rows = listStoreFlights().unwrapOr([]);
    const kept: StoreFlightReport[] = [];
    for (const entry of rows) {
        if (entry.flight.state !== "failed" && !isPidAlive(entry.flight.holderPid)) {
            deleteStoreFlight(entry.flight.id).unwrapOr(0);
            continue;
        }
        kept.push({ row: entry.flight, analysisIds: entry.analysisIds });
    }
    return kept;
}

// --- The pending set -----------------------------------------------------------

/** Why an enqueue could not land. */
export type StoreEnqueueError =
    { readonly type: "merge_in_flight"; readonly message: string } | { readonly type: "enqueue_failed"; readonly message: string; readonly cause: unknown };

/**
 * Enqueue one approved add into the pending set.
 *
 * The enqueue REFUSES during a live catalog merge, because the flush acquires
 * into the same pool that the merge writes, and the two must not interleave —
 * the package-store-download spec names this refusal. A `running` row whose
 * holder is gone reads as failed, thus a dead downloader refuses nothing.
 */
export function enqueueStoreAdd(entry: {
    readonly name: string;
    readonly version: string | null;
    readonly ecosystem: StoreEcosystem | null;
    readonly analysisId: string | null;
}): Result<StoreFlightSpec, StoreEnqueueError> {
    const catalog = readTransferReport("catalog");
    if (catalog.live) {
        return err({
            type: "merge_in_flight",
            message:
                "A package-store download is in flight, and it merges into this same store root. Wait for it to finish, or run `inflexa store cancel` to stop it.",
        });
    }
    const spec: StoreFlightSpec = {
        ecosystem: entry.ecosystem,
        name: canonicalDistributionName(entry.name),
        specifier: entry.version === null ? "" : `==${entry.version.trim()}`,
    };
    return enqueuePendingStoreAdd({ name: spec.name, specifier: spec.specifier, ecosystem: spec.ecosystem, analysisId: entry.analysisId })
        .map(() => spec)
        .mapErr((cause): StoreEnqueueError => ({ type: "enqueue_failed", message: "Could not enqueue the add into the pending set.", cause }));
}

// --- The acquire report --------------------------------------------------------

/** One staged graph node of an acquire report, kept RAW: the commit writes these bytes into `deps.json`. */
const reportNodeSchema = z
    .object({
        track: z.enum(["python", "r"]),
        name: z.string(),
        version: z.string(),
        order: z.string().optional(),
        edges: z.array(z.string()).default([]),
    })
    .passthrough();

const reportOutcomeSchema = z
    .object({
        spec: z.string(),
        outcome: z.enum(["acquired", "refused", "both_hit"]),
        reason: z.string().optional(),
        candidates: z.array(z.object({ ecosystem: z.enum(["python", "r"]), name: z.string() }).passthrough()).optional(),
        store_dirs: z.array(z.string()).optional(),
    })
    .passthrough();

const acquireReportSchema = z
    .object({
        schema: z.literal(1),
        outcomes: z.array(reportOutcomeSchema),
        nodes: z.record(z.string(), reportNodeSchema).default({}),
    })
    .passthrough();

type AcquireReport = z.infer<typeof acquireReportSchema>;
type ReportNode = z.infer<typeof reportNodeSchema>;

// --- The graph commit ----------------------------------------------------------

/** The raw shape of `deps.json` at the store root, read leniently so the commit writes back what it read. */
const rawGraphSchema = z
    .object({
        version: z.number(),
        nodes: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
        by_name: z
            .object({
                python: z.record(z.string(), z.array(z.string())).default({}),
                r: z.record(z.string(), z.array(z.string())).default({}),
            })
            .default({ python: {}, r: {} }),
    })
    .passthrough();

/** Why the commit refused a staged node. The spec of the node drops out with this reason. */
type CommitRefusal = { readonly storeDir: string; readonly reason: string };

/**
 * Append the staged nodes of a green acquire report to `deps.json`, under the
 * store-level metadata mutex.
 *
 * The staged nodes resolve their edges inside the acquired set. A dependency
 * that the POOL already satisfied stays a bare distribution name, and this
 * commit maps it onto the head store directory of that name in the published
 * graph. A name that neither side resolves would be a dangling edge, and the
 * graph reader refuses a dangling edge whole — thus the commit refuses that
 * NODE instead, and its spec drops out with the reason.
 *
 * The `by_name` order stays the emitter's: ascending by the `order` string of
 * each node, then by the directory name. The host compares strings and orders
 * nothing itself.
 */
export async function commitStagedNodes(
    storeRoot: string,
    staged: Record<string, ReportNode>,
): Promise<Result<{ readonly committed: readonly string[]; readonly refused: readonly CommitRefusal[] }, ProvisionerError>> {
    return withStoreMetadataMutex(
        (holderPid): ProvisionerError => ({
            type: "store_locked",
            message: `Another \`inflexa\` process (pid ${holderPid}) holds the package-store metadata lock. Wait for it to finish, then run this command again.`,
        }),
        async () => {
            const graphPath = join(storeRoot, "deps.json");
            const raw = existsSync(graphPath)
                ? readFileResult(graphPath, "read the dependency graph").match(
                      (text) => JSON.parseWith(text, rawGraphSchema),
                      () => null,
                  )
                : { version: 1, nodes: {}, by_name: { python: {}, r: {} } };
            if (raw === null) {
                return err<never, ProvisionerError>({
                    type: "provisioner_failed",
                    code: 1,
                    message: `The dependency graph at ${graphPath} is unreadable, thus the acquired nodes cannot commit. Run \`inflexa store download\` to restore it.`,
                });
            }

            const refused: CommitRefusal[] = [];
            const accepted = new Map<string, ReportNode>();
            // A node commits only when each of its edges resolves. The pass repeats,
            // because a node whose edge names a refused sibling must drop with it.
            const pending = new Map(Object.entries(staged));
            for (;;) {
                let moved = false;
                for (const [storeDir, node] of [...pending.entries()]) {
                    const edges: string[] = [];
                    let bad: string | null = null;
                    for (const edge of node.edges) {
                        if (raw.nodes[edge] !== undefined || accepted.has(edge) || pending.has(edge)) {
                            edges.push(edge);
                            continue;
                        }
                        // A bare name: the pool satisfied this dependency before the run.
                        const head = raw.by_name[node.track][canonicalDistributionName(edge)]?.[0];
                        if (head === undefined) {
                            bad = edge;
                            break;
                        }
                        edges.push(head);
                    }
                    if (bad !== null) {
                        refused.push({ storeDir, reason: `the dependency "${bad}" resolves to nothing in the pool` });
                        pending.delete(storeDir);
                        moved = true;
                        continue;
                    }
                    if (edges.some((edge) => pending.has(edge))) continue;
                    if (edges.some((edge) => raw.nodes[edge] === undefined && !accepted.has(edge))) continue;
                    accepted.set(storeDir, { ...node, edges });
                    pending.delete(storeDir);
                    moved = true;
                }
                if (pending.size === 0) break;
                if (!moved) {
                    // The rest waits on a refused sibling, or forms a cycle the emitter
                    // never writes. Either way it cannot commit.
                    for (const [storeDir] of pending) refused.push({ storeDir, reason: "a dependency of it did not commit" });
                    break;
                }
            }

            if (accepted.size === 0) return ok({ committed: [], refused });

            for (const [storeDir, node] of accepted) {
                raw.nodes[storeDir] = node as Record<string, unknown>;
                const shelf = raw.by_name[node.track];
                const list = shelf[node.name] ?? [];
                if (!list.includes(storeDir)) list.push(storeDir);
                list.sort((one, two) => {
                    const orderOf = (dir: string): string => {
                        const entry = raw.nodes[dir];
                        const order = entry === undefined ? undefined : entry["order"];
                        return typeof order === "string" ? order : "";
                    };
                    const byOrder = orderOf(one).localeCompare(orderOf(two));
                    return byOrder !== 0 ? byOrder : one.localeCompare(two);
                });
                shelf[node.name] = list;
            }

            const temp = `${graphPath}.${process.pid}.tmp`;
            try {
                await Bun.write(temp, `${JSON.stringify(raw, null, 2)}\n`);
                const { renameSync } = await import("node:fs");
                renameSync(temp, graphPath);
            } catch (cause) {
                await rm(temp, { force: true }).catch(() => undefined);
                return err<never, ProvisionerError>({
                    type: "provisioner_failed",
                    code: 1,
                    message: `Could not write the dependency graph at ${graphPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                });
            }
            return ok({ committed: [...accepted.keys()], refused });
        },
    );
}

// --- The flush -----------------------------------------------------------------

/** What the flush did for ONE spec of the batch. Each variant is one line a surface renders. */
export type FlushSpecOutcome =
    | { readonly kind: "acquired"; readonly spec: StoreFlightSpec; readonly storeDirs: readonly string[] }
    | { readonly kind: "joined"; readonly spec: StoreFlightSpec }
    | { readonly kind: "refused"; readonly spec: StoreFlightSpec; readonly reason: string }
    | {
          readonly kind: "both_hit";
          readonly spec: StoreFlightSpec;
          readonly candidates: readonly { readonly ecosystem: StoreEcosystem; readonly name: string }[];
      };

/** What one flush produced: nothing to do, a refusal that put the batch back, or the outcomes of a run. */
export type FlushResult =
    | { readonly type: "empty" }
    | { readonly type: "deferred"; readonly reason: string }
    | { readonly type: "flew"; readonly outcomes: readonly FlushSpecOutcome[] };

/** The seams a flush caller can replace. Production passes none; a test pins the runners and shortens the waits. */
export type FlushDeps = {
    readonly run?: ProvisionerRunner;
    readonly loadCheck?: LoadCheckRunner;
    /** How many acquire runs go at one time. Default: the configured cap. */
    readonly cap?: number;
    /** How long one wait step is. Default: {@link FLIGHT_POLL_MS}. */
    readonly pollMs?: number;
    /** How long the flush waits for a live reclamation. Default: {@link RECLAIM_WAIT_MS}. */
    readonly reclaimWaitMs?: number;
    /** Report one line of the run. */
    readonly onProgress?: (line: string) => void;
};

/** Hold a new batch while a reclamation runs, and report the holder when the wait runs out. */
async function waitForReclaim(waitMs: number, pollMs: number): Promise<number | null> {
    for (let waited = 0; ; waited += pollMs) {
        const holder = instanceLockHolder(PACKAGE_STORE_RECLAIM_LOCK_KEY);
        if (holder === null) return null;
        if (waited >= waitMs) return holder;
        await Promise.sleep(pollMs);
    }
}

/** One batch entry: the spec, its flight key, and the analyses that subscribed to it through the pending set. */
type BatchEntry = { readonly key: string; readonly spec: StoreFlightSpec; readonly analysisIds: Set<string> };

/** Group the claimed pending adds by flight key, so one spec asked by two analyses is one batch member. */
function groupPendingAdds(entries: readonly PendingStoreAdd[]): BatchEntry[] {
    const byKey = new Map<string, BatchEntry>();
    for (const entry of entries) {
        const spec: StoreFlightSpec = { ecosystem: entry.ecosystem, name: entry.name, specifier: entry.specifier };
        const key = storeFlightKey(spec);
        const existing = byKey.get(key) ?? { key, spec, analysisIds: new Set<string>() };
        if (entry.analysisId !== null) existing.analysisIds.add(entry.analysisId);
        byKey.set(key, existing);
    }
    return [...byKey.values()];
}

/** Put a claimed batch back into the pending set, because the flush cannot run now and the approvals must not vanish. */
function requeueBatch(entries: readonly PendingStoreAdd[]): void {
    for (const entry of entries) {
        enqueuePendingStoreAdd({ name: entry.name, specifier: entry.specifier, ecosystem: entry.ecosystem, analysisId: entry.analysisId }).unwrapOr(undefined);
    }
}

/**
 * Flush the pending set: claim it whole, run ONE provisioner `acquire` for the
 * batch, run the load check inside the sandbox image, commit the staged nodes,
 * and extend the farm of each subscribed analysis.
 *
 * Per-spec outcomes are the contract: a spec that cannot resolve drops out
 * with its own refusal, and the rest of the set still lands. A both-hit name
 * stops with its two candidates, and only its caller can name the ecosystem.
 *
 * A refused spec also settles as a terminal `failed` flight row, with the
 * phase and the whole error text. That row is the surface of a DETACHED
 * flush, whose stdio nobody reads, and a retry of the spec clears it.
 *
 * A flush that cannot run — a live catalog merge, a live reclamation that
 * outwaits the bound — puts the claimed entries BACK, because an approval must
 * not vanish into a transient condition.
 */
export async function flushPendingStoreAdds(storeRoot: string, deps: FlushDeps = {}): Promise<Result<FlushResult, ProvisionerError>> {
    const claimed = claimPendingStoreAdds().unwrapOr([]);
    if (claimed.length === 0) return ok({ type: "empty" });
    const pollMs = deps.pollMs ?? FLIGHT_POLL_MS;
    const progress = (line: string): void => {
        try {
            deps.onProgress?.(line);
        } catch {
            // A progress readout is decoration over work that is otherwise succeeding.
        }
    };

    // A catalog merge writes into the same pool. The enqueue already refuses
    // during one, and this covers a merge that started between the enqueue and
    // the flush.
    if (readTransferReport("catalog").live) {
        requeueBatch(claimed);
        return ok({ type: "deferred", reason: "a package-store download merges into this store right now — the batch flushes after it" });
    }

    const blocker = await waitForReclaim(deps.reclaimWaitMs ?? RECLAIM_WAIT_MS, pollMs);
    if (blocker !== null) {
        requeueBatch(claimed);
        return ok({ type: "deferred", reason: `a package-store reclamation (pid ${blocker}) runs right now — the batch flushes after it` });
    }

    // The claim decides the batch: a spec whose flight another process owns
    // joins that flight (its analyses subscribe), and this batch acquires the
    // rest. The sweep first, so a dead owner's debris dedups nothing.
    readStoreFlights();
    const outcomes: FlushSpecOutcome[] = [];
    const batch: BatchEntry[] = [];
    for (const entry of groupPendingAdds(claimed)) {
        const claim = claimStoreFlight({
            id: entry.key,
            ecosystem: entry.spec.ecosystem,
            name: entry.spec.name,
            specifier: entry.spec.specifier,
            holderPid: process.pid,
        });
        // A claim QUERY failure is its own refusal, never "joined": a broken
        // ledger must not read as a live duplicate, because "joined" tells the
        // caller that somebody else does the work, and here nobody does.
        if (claim.isErr()) {
            outcomes.push({
                kind: "refused",
                spec: entry.spec,
                reason: `the flight ledger could not be claimed (${describeDbError(claim.error)}) — nothing was acquired for this spec`,
            });
            continue;
        }
        for (const analysisId of entry.analysisIds) subscribeStoreFlight({ flightId: entry.key, analysisId }).unwrapOr(0);
        if (entry.analysisIds.size === 0) subscribeStoreFlight({ flightId: entry.key, analysisId: null }).unwrapOr(0);
        if (claim.value) batch.push(entry);
        else outcomes.push({ kind: "joined", spec: entry.spec });
    }
    if (batch.length === 0) return ok({ type: "flew", outcomes });

    const keys = batch.map((entry) => entry.key);
    // The recorded refusals, keyed by flight key: `<phase>: <whole error text>`.
    // The tail settles these rows as `failed` instead of deleting them, thus a
    // refusal of a DETACHED flush survives the process — the row is the one
    // durable surface, and no truncation happens at record time.
    const failures = new Map<string, string>();
    const failWholeBatch = (phase: "resolve" | "load_check" | "commit", message: string): void => {
        for (const entry of batch) {
            if (!failures.has(entry.key)) failures.set(entry.key, `${phase}: ${message}`);
        }
    };
    try {
        // One slot per RUN under the cap. The wait ends when the batch promotes whole.
        const cap = deps.cap ?? storeFlightConcurrency();
        for (;;) {
            const promoted = promoteStoreFlightBatch({ ids: keys, holderPid: process.pid, cap }).unwrapOr(0);
            if (promoted >= keys.length) break;
            await Promise.sleep(pollMs);
        }

        // Phase one: the acquire run. The report lands inside the store metadata
        // directory, thus the load-check container reads it through the same mount.
        const reportName = join(".inflexa-download", `acquire-${process.pid}-${randomUUIDv7()}.json`);
        const run = deps.run ?? runProvisioner;
        let lastWrite = 0;
        const onLine = (line: string): void => {
            progress(line);
            const now = Date.now();
            if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
            lastWrite = now;
            // Discarded on failure, and deliberately: the row is a readout, thus a
            // database this process cannot write must never abort an acquisition.
            for (const key of keys) recordStoreFlightProgress({ id: key, progress: line }).unwrapOr(0);
        };
        const specs = batch.map((entry) => provisionerSpec(entry.spec));
        const ran = await run({ storeRoot, egressAllow: ACQUIRE_EGRESS_ALLOW, args: ["acquire", "--report", `/mnt/libs/${reportName}`, ...specs] }, onLine);
        if (ran.isErr()) {
            failWholeBatch("resolve", ran.error.message);
            return err(ran.error);
        }
        const classified = classifyProvisionerRun(ran.value);
        if (classified.isErr()) {
            failWholeBatch("resolve", classified.error.message);
            return err(classified.error);
        }

        const reportPath = join(storeRoot, reportName);
        const rawReport = await readFile(reportPath, "utf8").catch(() => null);
        const report: AcquireReport | null = rawReport === null ? null : JSON.parseWith(rawReport, acquireReportSchema);
        if (report === null) {
            const message = `The acquire run wrote no readable report at ${reportPath}.`;
            failWholeBatch("resolve", message);
            return err({ type: "provisioner_failed", code: 0, message });
        }

        // The report speaks per spec, in the provisioner's own spelling. Map each
        // outcome back onto its batch entry through that spelling.
        const bySpec = new Map(batch.map((entry) => [provisionerSpec(entry.spec), entry]));
        const acquired: { entry: BatchEntry; storeDirs: string[] }[] = [];
        for (const outcome of report.outcomes) {
            const entry = bySpec.get(outcome.spec);
            if (entry === undefined) continue;
            switch (outcome.outcome) {
                case "acquired":
                    acquired.push({ entry, storeDirs: outcome.store_dirs ?? [] });
                    break;
                case "refused": {
                    const reason = outcome.reason ?? "the spec did not resolve";
                    outcomes.push({ kind: "refused", spec: entry.spec, reason });
                    failures.set(entry.key, `resolve: ${reason}`);
                    break;
                }
                case "both_hit":
                    outcomes.push({ kind: "both_hit", spec: entry.spec, candidates: outcome.candidates ?? [] });
                    break;
                default: {
                    const unreachable: never = outcome.outcome;
                    throw new Error(`unhandled acquire outcome: ${JSON.stringify(unreachable)}`);
                }
            }
        }

        // Phase two: the load check, inside the SANDBOX image, over the staged
        // nodes of the SAME report file. It proves the image that runs the code.
        // A red check drops the failed packages — and every spec that carries
        // one — before the commit.
        let staged: Record<string, ReportNode> = { ...report.nodes };
        if (acquired.length > 0 && Object.keys(staged).length > 0) {
            progress("[flight] load check of the acquired set (sandbox image, no network)");
            const check = await (deps.loadCheck ?? runLoadCheck)({ storeRoot, reportName });
            if (check.isErr()) {
                failWholeBatch("load_check", check.error.message);
                return err(check.error);
            }
            const failedDirs = check.value.code === 0 ? new Map<string, string>() : failedLoadResults(check.value.stdout, Object.keys(staged));
            if (failedDirs.size > 0) {
                staged = Object.fromEntries(Object.entries(staged).filter(([dir]) => !failedDirs.has(dir)));
                for (let index = acquired.length - 1; index >= 0; index -= 1) {
                    const item = acquired[index] as { entry: BatchEntry; storeDirs: string[] };
                    const bad = item.storeDirs.filter((dir) => failedDirs.has(dir));
                    if (bad.length > 0) {
                        const detail = bad.map((dir) => `${dir}: ${failedDirs.get(dir) ?? "no reason recorded"}`).join("\n");
                        const reason = `the load check failed inside the sandbox image — nothing was advertised:\n${detail}`;
                        outcomes.push({ kind: "refused", spec: item.entry.spec, reason });
                        failures.set(item.entry.key, `load_check: ${reason}`);
                        for (const dir of item.storeDirs) delete staged[dir];
                        acquired.splice(index, 1);
                    }
                }
            }
        }
        await rm(reportPath, { force: true }).catch(() => undefined);

        // The commit, under the metadata lock. A node whose dependency did not
        // commit drops its spec too, with the reason.
        if (acquired.length > 0) {
            const committed = await commitStagedNodes(storeRoot, staged);
            if (committed.isErr()) {
                failWholeBatch("commit", committed.error.message);
                return err(committed.error);
            }
            const refusedDirs = new Map(committed.value.refused.map((refusal) => [refusal.storeDir, refusal.reason]));
            for (let index = acquired.length - 1; index >= 0; index -= 1) {
                const item = acquired[index] as { entry: BatchEntry; storeDirs: string[] };
                const bad = item.storeDirs.find((dir) => refusedDirs.has(dir));
                if (bad !== undefined) {
                    const reason = refusedDirs.get(bad) ?? "the commit refused a dependency";
                    outcomes.push({ kind: "refused", spec: item.entry.spec, reason });
                    failures.set(item.entry.key, `commit: ${reason}`);
                    acquired.splice(index, 1);
                }
            }
        }

        // The farm extensions: each subscribed analysis gains the closure of its
        // own spec. Nothing here can fail the acquisition — the packages are in
        // the pool and the graph whatever the farms do.
        for (const item of acquired) {
            outcomes.push({ kind: "acquired", spec: item.entry.spec, storeDirs: item.storeDirs });
            const analyses = new Set(item.entry.analysisIds);
            for (const flight of listStoreFlights().unwrapOr([])) {
                if (flight.flight.id === item.entry.key) for (const id of flight.analysisIds) analyses.add(id);
            }
            for (const analysisId of analyses) {
                if (!existsSync(analysisFarmPath(storeRoot, analysisId))) continue;
                const extended = await extendFarm({ storeRoot, analysisId, roots: item.storeDirs });
                extended.match(
                    () => progress(`[flight] extended the farm of the analysis ${analysisId} with ${describeStoreFlightSpec(item.entry.spec)}`),
                    (error) => progress(`[flight] the farm of the analysis ${analysisId} was not extended: ${describeFarmCompositionError(error)}`),
                );
            }
        }

        return ok({ type: "flew", outcomes });
    } finally {
        // A refused key settles as a terminal `failed` row, and every other key
        // deletes — a success row that everyone has is noise. A settle that
        // cannot write leaves a live row with a dead holder, and the next read
        // sweeps it: the record is best-effort over a database this process
        // could stop being able to write.
        for (const key of keys) {
            const message = failures.get(key);
            if (message === undefined) deleteStoreFlight(key).unwrapOr(0);
            else settleStoreFlightFailure({ id: key, message }).unwrapOr(0);
        }
    }
}

/** One line of a ledger failure: the variant, with the cause the driver reported. */
function describeDbError(error: DbError): string {
    const cause = "cause" in error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.type}${cause}`;
}

/**
 * The store directories whose load check failed, with the error text of each,
 * read from the check's JSON stdout. For a staged-node check, the `package`
 * field of each result IS the store directory key. A stdout that does not
 * parse names every staged directory, because a red check with an unreadable
 * verdict must not commit anything — the whole output then stands as the
 * reason.
 */
function failedLoadResults(stdout: string, stagedDirs: readonly string[]): Map<string, string> {
    const parsed = JSON.parseWith(
        stdout,
        z
            .object({ results: z.array(z.object({ package: z.string(), ok: z.boolean(), error: z.string().optional() }).passthrough()).default([]) })
            .passthrough(),
    );
    if (parsed === null) return new Map(stagedDirs.map((dir) => [dir, `the check wrote no readable verdict. Its output:\n${stdout}`]));
    const failed = new Map<string, string>();
    for (const result of parsed.results) {
        if (!result.ok) failed.set(result.package, result.error ?? "the check named no reason");
    }
    // A red exit with no named failure still must not commit: name everything.
    return failed.size > 0 ? failed : new Map(stagedDirs.map((dir) => [dir, `the check exited red and named no failure. Its output:\n${stdout}`]));
}

/**
 * The count check the reclamation uses: whether ANY flight row with a live
 * holder exists. The reclamation must not free a store directory that a live
 * batch is about to reference, and the flight rows are the record of exactly
 * that. A `failed` row is a terminal record, not live work, thus it blocks
 * nothing.
 */
export function anyLiveStoreFlight(): boolean {
    return readStoreFlights().some((flight) => flight.row.state !== "failed");
}

/** Whether a flight of one key still carries a subscriber. Exported for the surfaces that render a join. */
export function storeFlightSubscribers(flightId: string): number {
    return countStoreFlightSubscribers(flightId).unwrapOr(0);
}

/** How much of a recorded reason the one-line renders carry. The row keeps the whole text. */
const FAILURE_PROSE_HEAD_CHARS = 120;

/** The plain sentence of each failure phase. The record keeps the phase token; only the render translates. */
const FAILURE_PHASE_PROSE: Record<string, string> = {
    resolve: "the version did not resolve against the index",
    load_check: "the package failed its import proof inside the sandbox image",
    commit: "a dependency of it did not land in the pool",
};

/**
 * A recorded flight failure as user prose: the phase mapped onto one plain
 * sentence, then a bounded head of the raw reason behind it. The record stays
 * whole — this bounds and translates the RENDER only. The dialog, and the
 * launch remedy, read failures through this one vocabulary.
 */
export function describeRecordedFlightFailure(message: string | null): string {
    if (message === null || message.trim() === "") return "no reason was recorded";
    const split = message.indexOf(": ");
    const phase = split > 0 ? message.slice(0, split) : "";
    const prose = FAILURE_PHASE_PROSE[phase];
    const raw = prose === undefined ? message : message.slice(split + 2);
    const first = raw.split("\n", 1)[0] ?? raw;
    const head = first.length <= FAILURE_PROSE_HEAD_CHARS ? first : `${first.slice(0, FAILURE_PROSE_HEAD_CHARS)}…`;
    return prose === undefined ? head : `${prose} (${head})`;
}

/**
 * Classify one pool miss against the host rows, for the launch refusal: in
 * flight, failed with its recorded reason, or unknown. `undefined` is the
 * unknown case — the seam's own `absent` outcome already directs the ask, and
 * a detail would only restate it.
 */
export function classifyPoolMiss(name: string): string | undefined {
    const canonical = canonicalDistributionName(name);
    const pending = listPendingStoreAdds()
        .unwrapOr([])
        .some((entry) => entry.name === canonical);
    const rows = readStoreFlights();
    const live = rows.some((flight) => flight.row.name === canonical && flight.row.state !== "failed");
    if (pending || live) return "its acquisition is in flight — launch again when it lands";
    const failed = rows.find((flight) => flight.row.name === canonical && flight.row.state === "failed");
    if (failed !== undefined) return `its last flight failed: ${describeRecordedFlightFailure(failed.row.message)} — retry it or delete the record`;
    return undefined;
}
