/**
 * The acquisition flights of `inflexa store add`.
 *
 * A flight is the work of acquiring ONE normalized spec into the content-addressed pool. The key of a
 * flight is that spec: the ecosystem, the PEP 503 canonical name, and the specifier. One flight lives
 * for each key, thus a second request for the same spec starts no second provisioner container. It
 * subscribes to the flight that is already live and it reports the progress of that flight as its own.
 *
 * A subscription belongs to an analysis. A cancel removes ONE subscription, and the flight stops when
 * none remains. A subscription with no analysis is `inflexa store add` with no `--analysis`: it keeps the
 * flight alive, and it has no farm to extend.
 *
 * A flight extends NO farm. Each caller extends its own farm when its own call resolves, which `store.ts`
 * does. An owner that died between the acquisition and the extension would otherwise leave a subscriber
 * short, and the row that named the subscribers is gone by then. Each caller knows its own analysis.
 *
 * Flights for different keys run at the same time, under a small concurrency cap. The cap is real work
 * protection and not politeness: an R source compile can exhaust the memory of a small machine.
 *
 * The user-facing shape is the shape of the detached download lifecycle — one database row, named
 * states, and one liveness signal — applied to a second writer. Two things are deliberately different:
 *
 * - The liveness signal is the `holder_pid` column and not an instance lock. A download has one fixed
 *   key, thus one lock file. A flight key is minted at runtime, and a lock file for each key would carry
 *   no more truth than the column. {@link isPidAlive} stays the one probe, so "dead" means the same
 *   thing to both records.
 * - A finished flight is NOT a cache. The owner removes the row on each outcome, thus a failed
 *   acquisition leaves nothing that would dedup the next request for the same spec.
 *
 * A subscriber therefore learns that the flight ended and never how it ended: the row that carried the
 * verdict is gone. That is the price of the no-cache rule, and the remedy is `inflexa store ls`, which
 * reads what the store holds now.
 */

import { err, ok, type Result } from "neverthrow";

import { readConfig } from "../../lib/config.ts";
import { instanceLockHolder, isPidAlive, LIB_STORE_RECLAIM_LOCK_KEY } from "../../lib/lock.ts";
import { countLibStoreFlightSubscribers, getLibStoreFlight, hasLibStoreFlightSubscriber, listLibStoreFlights } from "../../db/primary_query.ts";
import {
    claimLibStoreFlight,
    deleteLibStoreFlight,
    promoteLibStoreFlight,
    recordLibStoreFlightProgress,
    subscribeLibStoreFlight,
    unsubscribeLibStoreFlight,
} from "../../db/primary_mutation.ts";
import { canonicalDistributionName } from "./composition.ts";

/** The package ecosystems a flight can acquire. The store carries the two tracks, and the key separates them. */
export type LibStoreEcosystem = "python" | "r";

/**
 * The live states of one flight. There is no terminal state, because a finished flight removes its row.
 *
 * `queued` is a flight that owns its key and waits for a slot under the concurrency cap. `running` is a
 * flight whose provisioner container is up.
 */
export type LibStoreFlightStatus = "queued" | "running";

/**
 * The normalized spec that keys a flight.
 *
 * `name` is PEP 503 canonical, thus `Scanpy`, `scan_py`, and `scan.py` all key one flight. `specifier`
 * is everything the request wrote after the name, with each space removed — the extras AND the version
 * constraint. Two requests that differ in either are two different acquisitions, thus they must not
 * share a flight.
 */
export type LibStoreFlightSpec = {
    readonly ecosystem: LibStoreEcosystem;
    readonly name: string;
    readonly specifier: string;
};

/**
 * The persisted row of one live flight.
 *
 * The shape lives beside the flight rather than in `src/types/`, because the flight is its one consumer.
 * `src/db/` takes it as a type-only import, thus the storage layer keeps no runtime dependency on this
 * module — the same arrangement the download row has.
 */
export type LibStoreFlightRow = {
    /** The flight key: the ecosystem, the canonical name, and the specifier, joined. */
    readonly id: string;
    /** When the owner claimed the key, epoch millis. */
    readonly createdAt: number;
    /** When the last write landed, epoch millis. */
    readonly updatedAt: number;
    /** The live state. */
    readonly state: LibStoreFlightStatus;
    /** The ecosystem of the acquired spec. */
    readonly ecosystem: LibStoreEcosystem;
    /** The PEP 503 canonical distribution name. */
    readonly name: string;
    /** The extras and the version constraint, with no space. Empty when the request named neither. */
    readonly specifier: string;
    /** The newest provisioner line, or `null` before the container writes one. */
    readonly progress: string | null;
    /** The process that owns the flight. A row whose holder is dead is debris that the next request sweeps. */
    readonly holderPid: number;
};

/** One live flight as a reader sees it: the row, and the analyses subscribed to it. */
export type LibStoreFlightReport = {
    readonly row: LibStoreFlightRow;
    /** The analyses subscribed. A subscription that belongs to no analysis contributes no id. */
    readonly analysisIds: readonly string[];
};

/** Why a flight could not start. Each variant maps to one actionable user message. */
export type LibStoreFlightError =
    { readonly type: "invalid_spec"; readonly spec: string; readonly message: string } | { readonly type: "reclaim_in_flight"; readonly message: string };

/**
 * What one request for a spec produced.
 *
 * `flew` means that this call owned the flight and ran the work, and it carries what the work produced.
 * `joined` means that a flight was already live for the key: this call subscribed, waited, and the
 * flight ended. `canceled` means that the subscription of this call was removed before the flight ended.
 */
export type LibStoreFlightOutcome<T> =
    | { readonly type: "flew"; readonly spec: LibStoreFlightSpec; readonly value: T }
    | { readonly type: "joined"; readonly spec: LibStoreFlightSpec }
    | { readonly type: "canceled"; readonly spec: LibStoreFlightSpec };

/** The work one flight owner runs, with the two channels the flight gives it. */
export type LibStoreFlightWork<T, E> = (context: {
    /** Aborted when the last subscription is cancelled, so the work stops instead of finishing for nobody. */
    readonly signal: AbortSignal;
    /** Report one line of the work, which the row carries to each subscriber. */
    readonly onProgress: (line: string) => void;
}) => Promise<Result<T, E>>;

/** The seams a caller can replace. Production passes none; a test shortens the waits and pins the cap. */
export type LibStoreFlightDeps = {
    /** How many flights run at one time. Default: the configured cap, else {@link DEFAULT_FLIGHT_CONCURRENCY}. */
    readonly cap?: number;
    /** How long one wait step is. Default: {@link FLIGHT_POLL_MS}. */
    readonly pollMs?: number;
    /** How long a flight waits for a live reclamation before it refuses. Default: {@link RECLAIM_WAIT_MS}. */
    readonly reclaimWaitMs?: number;
};

/**
 * How many flights run at one time when the configuration names no cap.
 *
 * Two, because an R source compile can exhaust the memory of a small machine, and a package index is
 * rarely the limit. The user raises it through `store.flightConcurrency` in the configuration.
 */
export const DEFAULT_FLIGHT_CONCURRENCY = 2;

/**
 * How long one wait step is: a queued flight asks for a slot again, and a subscriber reads the row again.
 *
 * The writer is a different process for the cross-terminal case, thus a read is the only way this one
 * learns that the flight moved. The read is one point lookup by primary key against a WAL database, so
 * it never blocks that writer.
 */
const FLIGHT_POLL_MS = 250;

/** How long a new flight waits for a live reclamation to finish before it refuses. */
const RECLAIM_WAIT_MS = 120_000;

/** How often a live flight writes its newest provisioner line, so a chatty container costs one row write for each step. */
const PROGRESS_WRITE_INTERVAL_MS = 500;

/** The characters that can start a specifier: an extras list, a version constraint, a direct reference, or a marker. */
const SPECIFIER_START = /^[[<>=!~@;(]/;

/** The leading distribution name of a requirement, before the extras and before the version constraint. */
const REQUIREMENT_NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/;

/**
 * Read one request from the user as the normalized spec that keys a flight.
 *
 * The name is canonical, thus two spellings of one distribution meet at one flight. Everything after the
 * name is the specifier, with each space removed, thus `numpy == 1.26.4` and `numpy==1.26.4` key one
 * flight while `numpy==1.26.4` and `numpy>=1.26` key two.
 */
export function parseLibStoreFlightSpec(raw: string, ecosystem: LibStoreEcosystem): Result<LibStoreFlightSpec, LibStoreFlightError> {
    const trimmed = raw.trim();
    const matched = REQUIREMENT_NAME.exec(trimmed);
    if (matched === null) {
        return err({
            type: "invalid_spec",
            spec: raw,
            message: `"${raw}" does not start with a package name. Write a name, and add a version constraint after it, for example \`numpy==1.26.4\`.`,
        });
    }
    const name = matched[1] ?? "";
    const rest = trimmed.slice(name.length).replace(/\s+/g, "");
    if (rest !== "" && !SPECIFIER_START.test(rest)) {
        return err({
            type: "invalid_spec",
            spec: raw,
            message: `"${raw}" carries "${rest}" after the package name, which is not a version constraint or an extras list.`,
        });
    }
    return ok({ ecosystem, name: canonicalDistributionName(name), specifier: rest });
}

/**
 * The key of a flight: the ecosystem, the canonical name, and the specifier, joined with `::`.
 *
 * Neither ecosystem permits a colon in a package name, thus the first two occurrences are always the
 * separators. The key holds no control character. A source file that carries one reads as binary to
 * `grep` and to `file`. A search on that file then returns nothing, and it gives no warning.
 */
export function libStoreFlightKey(spec: LibStoreFlightSpec): string {
    return `${spec.ecosystem}::${spec.name}::${spec.specifier}`;
}

/** The spec as a user reads it, for a report line: the ecosystem, then the requirement. */
export function describeLibStoreFlightSpec(spec: LibStoreFlightSpec): string {
    return `${spec.ecosystem} ${spec.name}${spec.specifier}`;
}

/** The configured concurrency cap, or the default when the configuration names none. */
export function libStoreFlightConcurrency(): number {
    return readConfig().store?.flightConcurrency ?? DEFAULT_FLIGHT_CONCURRENCY;
}

/**
 * Remove each flight row whose owner is gone, then report the flights that are live.
 *
 * A killed owner writes no ending, thus its row would dedup every later request for that spec against
 * work that stopped. The sweep is what makes the pid column a liveness signal rather than a claim, and
 * it runs before every read and before every claim.
 *
 * A read failure degrades to an empty list rather than an error. The database is a file on the machine
 * of the user, and a store that a reader cannot describe is still a store that works.
 */
export function readLibStoreFlights(): readonly LibStoreFlightReport[] {
    const rows = listLibStoreFlights().unwrapOr([]);
    const live: LibStoreFlightReport[] = [];
    for (const entry of rows) {
        if (!isPidAlive(entry.flight.holderPid)) {
            deleteLibStoreFlight(entry.flight.id).unwrapOr(0);
            continue;
        }
        live.push({ row: entry.flight, analysisIds: entry.analysisIds });
    }
    return live;
}

/** What a cancel did. Each answer is normal: a cancel of nothing changes nothing. */
export type LibStoreFlightCancel =
    { readonly type: "unsubscribed"; readonly remaining: number } | { readonly type: "no_subscription" } | { readonly type: "no_flight" };

/**
 * Cancel one subscription to a live flight.
 *
 * A cancel is an unsubscribe and never a stop: the flight goes on for each other subscriber. It stops
 * when the count reaches zero, and the owner is what reads that count and aborts its work. Thus a cancel
 * of the last subscription reports `remaining: 0`, and the owner ends the flight within one wait step.
 */
export function cancelLibStoreFlight(params: { spec: LibStoreFlightSpec; analysisId: string | null }): LibStoreFlightCancel {
    const id = libStoreFlightKey(params.spec);
    if (getLibStoreFlight(id).unwrapOr(null) === null) return { type: "no_flight" };
    const removed = unsubscribeLibStoreFlight({ flightId: id, analysisId: params.analysisId }).unwrapOr(0);
    if (removed === 0) return { type: "no_subscription" };
    return { type: "unsubscribed", remaining: countLibStoreFlightSubscribers(id).unwrapOr(0) };
}

/**
 * Run one acquisition as a flight, or join the flight that is already live for its spec.
 *
 * The order is deliberate. A live reclamation blocks a new flight first, because a reclaim frees pool
 * content and a flight is about to reference it. The claim is one atomic insert, thus the winner runs
 * the work and each other caller subscribes. The owner then waits for a slot under the cap, runs, and
 * removes the row on every exit path — a success, a failure, and a cancel all end the flight.
 */
export async function withLibStoreFlight<T, E>(
    params: {
        readonly spec: LibStoreFlightSpec;
        readonly analysisId: string | null;
        /**
         * Report each new progress line of a flight that another caller owns, so a subscriber reports
         * the same progress as the owner. The owner reports through the work context instead.
         */
        readonly onProgress?: (line: string) => void;
    },
    work: LibStoreFlightWork<T, E>,
    deps: LibStoreFlightDeps = {},
): Promise<Result<LibStoreFlightOutcome<T>, E | LibStoreFlightError>> {
    const pollMs = deps.pollMs ?? FLIGHT_POLL_MS;
    const id = libStoreFlightKey(params.spec);

    const waited = await waitForReclaim(deps.reclaimWaitMs ?? RECLAIM_WAIT_MS, pollMs);
    if (waited.isErr()) return err(waited.error);

    readLibStoreFlights();
    const claimed = claimLibStoreFlight({
        id,
        ecosystem: params.spec.ecosystem,
        name: params.spec.name,
        specifier: params.spec.specifier,
        holderPid: process.pid,
    }).unwrapOr(false);
    subscribeLibStoreFlight({ flightId: id, analysisId: params.analysisId }).unwrapOr(0);
    if (!claimed) {
        const joined = await joinLibStoreFlight(
            { id, spec: params.spec, analysisId: params.analysisId, ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }) },
            pollMs,
        );
        return ok(joined);
    }

    try {
        const slot = await waitForSlot(id, deps.cap ?? libStoreFlightConcurrency(), pollMs);
        if (!slot) return ok({ type: "canceled", spec: params.spec });
        const controller = new AbortController();
        // The subscriber count is the stop condition, and it changes in another process, thus a poll is
        // the only way this one learns it. The timer is cleared on every exit path below.
        const watch = setInterval(() => {
            if (countLibStoreFlightSubscribers(id).unwrapOr(1) === 0) controller.abort();
        }, pollMs);
        let lastWrite = 0;
        try {
            const result = await work({
                signal: controller.signal,
                onProgress: (line) => {
                    const now = Date.now();
                    if (now - lastWrite < PROGRESS_WRITE_INTERVAL_MS) return;
                    lastWrite = now;
                    // Discarded on failure, and deliberately: the row is a readout, thus a database this
                    // process cannot write must never abort an acquisition that is otherwise succeeding.
                    recordLibStoreFlightProgress({ id, progress: line }).unwrapOr(0);
                },
            });
            // The abort wins over the result of the work, because a container that the abort killed
            // reports a non-zero exit that describes the cancel and not a fault of the acquisition.
            if (controller.signal.aborted) return ok({ type: "canceled", spec: params.spec });
            return result.map((value) => ({ type: "flew", spec: params.spec, value }) as const);
        } finally {
            clearInterval(watch);
        }
    } finally {
        deleteLibStoreFlight(id).unwrapOr(0);
    }
}

/** Hold a new flight while a reclamation runs, and refuse when the wait runs out. */
async function waitForReclaim(waitMs: number, pollMs: number): Promise<Result<void, LibStoreFlightError>> {
    for (let waited = 0; ; waited += pollMs) {
        const holder = instanceLockHolder(LIB_STORE_RECLAIM_LOCK_KEY);
        if (holder === null) return ok(undefined);
        if (waited >= waitMs) {
            return err({
                type: "reclaim_in_flight",
                message: `A package-store reclamation (pid ${holder}) is running, and it frees pool content that this acquisition would reference. Wait for it to finish, then run this command again.`,
            });
        }
        await Promise.sleep(pollMs);
    }
}

/**
 * Hold a queued flight until a slot frees under the cap. Reports `false` when the last subscription was
 * cancelled while it waited, which is a stop before any container started.
 */
async function waitForSlot(id: string, cap: number, pollMs: number): Promise<boolean> {
    for (;;) {
        if (countLibStoreFlightSubscribers(id).unwrapOr(0) === 0) return false;
        if (promoteLibStoreFlight({ id, cap }).unwrapOr(0) === 1) return true;
        await Promise.sleep(pollMs);
    }
}

/**
 * Wait on a flight that another caller owns, and report how the wait ended.
 *
 * Three things end it. The row goes away, which is the flight ending. The owner dies, which leaves
 * debris that this call sweeps. The subscription of this call goes away, which is a cancel of this
 * subscriber while the flight goes on for another.
 */
async function joinLibStoreFlight(
    params: {
        readonly id: string;
        readonly spec: LibStoreFlightSpec;
        readonly analysisId: string | null;
        readonly onProgress?: (line: string) => void;
    },
    pollMs: number,
): Promise<LibStoreFlightOutcome<never>> {
    let reported: string | null = null;
    for (;;) {
        await Promise.sleep(pollMs);
        const row = getLibStoreFlight(params.id).unwrapOr(null);
        if (row === null) return { type: "joined", spec: params.spec };
        if (!isPidAlive(row.holderPid)) {
            deleteLibStoreFlight(params.id).unwrapOr(0);
            return { type: "joined", spec: params.spec };
        }
        if (!hasLibStoreFlightSubscriber({ flightId: params.id, analysisId: params.analysisId }).unwrapOr(true)) {
            return { type: "canceled", spec: params.spec };
        }
        // Only a NEW line is reported: the owner writes the row at its own cadence, and a poll that is
        // faster than that cadence would print one line many times.
        if (row.progress !== null && row.progress !== reported) {
            reported = row.progress;
            params.onProgress?.(row.progress);
        }
    }
}
