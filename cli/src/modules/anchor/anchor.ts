import { randomUUIDv7 } from "bun";
import { dirname, resolve } from "node:path";
import { ok, err, Result, ResultAsync } from "neverthrow";
import PQueue from "p-queue";
import type { Anchor, AnchorMarker } from "../../types/anchor.ts";
import type { DbError } from "../../db/errors.ts";
import { getAnchor, listAnchors } from "../../db/primary_query.ts";
import { insertAnchor, touchAnchor, updateAnchorCachedPath } from "../../db/primary_mutation.ts";
import { isDirWritable } from "../../lib/fs.ts";
import { canonicalPathAsync } from "../../lib/paths.ts";
import { withinDeadline } from "../../lib/timer.ts";
import { findMarkerUpwards, readMarker, replaceMarker, writeMarker, type MarkerError } from "./marker.ts";

/** Bridge a marker-layer failure into the db-layer error type so callers that return `Result<T, DbError>` can propagate it without widening their error union. */
function markerToDbError(op: string, e: MarkerError, kind: "query_failed" | "mutation_failed" = "query_failed"): DbError {
    return { type: kind, op, cause: e };
}

/**
 * `id` is the marker UUID (from the on-disk marker or freshly minted), stored as the
 * anchor row's primary key.
 */
async function makeAnchor(id: string, dir: string, markerWritten: boolean): Promise<Anchor> {
    const cachedPath = await canonicalPathAsync(dir);
    const now = Date.now();
    return { id, cachedPath, markerWritten, createdAt: now, updatedAt: now, lastSeen: now };
}

/**
 * Why {@link getOrCreateAnchorForCwd} gave no anchor.
 *
 * - `folder_is_copy`: the marker of `dir` names an anchor whose known folder `original` still holds the same
 *   marker, thus `dir` is a copy and must not take the identity of the original.
 * - `original_unverified`: the read of the marker at `original` did not answer, thus `dir` can be a copy or
 *   a move, and neither a heal nor a copy decision is safe.
 * - `marker_unreadable`: the marker of `dir` exists, and the user cannot read it, for example a file of a
 *   different user. A new marker would take the identity of a folder that is not theirs.
 */
export type AnchorEnsureError =
    | DbError
    | { type: "folder_is_copy"; dir: string; original: string }
    | { type: "original_unverified"; dir: string; original: string }
    | { type: "marker_unreadable"; path: string; cause: unknown };

/**
 * Ensure `dir` is a tracked anchor and return its row. The single entry point used at
 * analysis creation and context resolution.
 *
 * WRITES TO DISK: in a writable dir with no marker, this mints an anchor and writes a
 * `.inflexa/id` marker. Call it only from a deliberate user action (e.g. analysis creation),
 * never from a passive/background flow like TUI launch — that would litter markers in every
 * folder the app opens (no-litter policy). For startup reconciliation use {@link recoverAnchors}.
 */
export function getOrCreateAnchorForCwd(dir: string): ResultAsync<Anchor, AnchorEnsureError> {
    return new ResultAsync(getOrCreateAnchor(dir));
}

async function getOrCreateAnchor(dir: string): Promise<Result<Anchor, AnchorEnsureError>> {
    const abs = await canonicalPathAsync(dir);

    const markerResult = await readMarker(abs);
    if (markerResult.isErr()) {
        const e = markerResult.error;
        switch (e.type) {
            case "marker_read_failed":
                return err({ type: "marker_unreadable", path: e.path, cause: e.cause });
            case "marker_corrupt":
                // The deliberate create replaces a corrupt marker: its id cannot be read, thus no row can be
                // reached through it, and the walk of each passive read already reads it as no marker.
                return mintAnchor(abs, (anchorId) => replaceMarker(abs, anchorId));
            case "marker_write_failed":
                return err(markerToDbError("getOrCreateAnchorForCwd:readMarker", e));
            default: {
                const exhaustive: never = e;
                throw new Error(`unhandled marker error: ${JSON.stringify(exhaustive)}`);
            }
        }
    }
    const marker = markerResult.value;

    if (marker) {
        const anchorId = marker.anchorId;
        const existing = getAnchor(anchorId);
        if (existing.isErr()) return err(existing.error);
        // Marker on disk but no DB row (DB reset, or folder authored on another
        // machine): re-establish the row keyed on the existing UUID to keep identity.
        if (!existing.value) return insertAnchor(await makeAnchor(anchorId, abs, true));
        // Self-heal a drifted cached path, but only for a move: a cached path that still holds this marker is
        // the original, and a heal would give its identity to the copy.
        if (existing.value.cachedPath !== abs) {
            const original = existing.value.cachedPath;
            const probe = await probeMarker(original, anchorId);
            if (probe === "match") return err({ type: "folder_is_copy", dir: abs, original });
            if (probe === "unknown") return err({ type: "original_unverified", dir: abs, original });
            const healed: Anchor = { ...existing.value, cachedPath: abs };
            return updateAnchorCachedPath(anchorId, abs).map(() => healed);
        }
        return ok(existing.value);
    }

    return mintAnchor(abs, (anchorId) => writeMarker(abs, anchorId));
}

/**
 * Mint a UUID for `abs` and insert its row. Only write a marker (with `write`) when the dir is writable;
 * otherwise the anchor degrades to path-only (markerWritten: false), per the spec.
 */
async function mintAnchor(abs: string, write: (anchorId: string) => ResultAsync<AnchorMarker, MarkerError>): Promise<Result<Anchor, DbError>> {
    const anchorId = randomUUIDv7();
    const writable = await isDirWritable(abs);
    if (writable) {
        const writeResult = await write(anchorId);
        if (writeResult.isErr()) return err(markerToDbError("getOrCreateAnchorForCwd:writeMarker", writeResult.error, "mutation_failed"));
    }
    return insertAnchor(await makeAnchor(anchorId, abs, writable));
}

/**
 * How long one marker read of a resolve can take before its answer is unknown. A folder on a hung network share
 * never answers, and a resolve that waits for it stops the request of a client.
 */
const MARKER_READ_LIMIT_MS = 2_000;

/**
 * The marker reads that have not settled, by folder. The read itself cannot be canceled, thus it keeps its thread
 * until the mount answers or fails. A probe of a folder with a read here joins that read and starts no second one,
 * thus a folder that does not answer holds one thread, however many resolves ask for it.
 */
const pendingReads = new Map<string, Promise<AnchorMarker | null>>();

/**
 * What a probe of the marker of a folder found. `unknown`: the read did not answer within
 * {@link MARKER_READ_LIMIT_MS}. The folder can hold the marker, thus no heal, no copy decision, and no count of
 * unique hits may act on it.
 */
type MarkerProbe = "match" | "no_match" | "unknown";

/**
 * Probe `dir` for a valid marker with the UUID `anchorId`. Corrupt or absent markers are
 * treated as non-matching here: resolution must not abort on an unrelated corrupt marker.
 */
async function probeMarker(dir: string, anchorId: string): Promise<MarkerProbe> {
    let read = pendingReads.get(dir);
    if (read === undefined) {
        const started = readMarker(dir).unwrapOr(null);
        read = started;
        pendingReads.set(dir, started);
        void started.finally(() => {
            if (pendingReads.get(dir) === started) pendingReads.delete(dir);
        });
    }
    const answer = await withinDeadline(read, MARKER_READ_LIMIT_MS, { unref: true });
    if (answer.kind === "timeout") return "unknown";
    return answer.value?.anchorId === anchorId ? "match" : "no_match";
}

/**
 * Walk up from startDir for the nearest marker matching uuid; corruption-safe (a corrupt
 * marker on the walk falls through to the bounded search rather than aborting resolution).
 */
function findMatchingMarkerUpwards(startDir: string, anchorId: string): Promise<string | null> {
    return findMarkerUpwards(startDir)
        .map((found) => (found && found.marker.anchorId === anchorId ? found.dir : null))
        .unwrapOr(null);
}

function ancestorsOf(dir: string): string[] {
    const out: string[] = [];
    let d = resolve(dir);
    for (;;) {
        out.push(d);
        const parent = dirname(d);
        if (parent === d) return out;
        d = parent;
    }
}

/** A resolved anchor and its current on-disk path (`null` when the folder can't be located). */
export type ResolvedAnchor = { anchor: Anchor; path: string | null };

/** Best-effort path: the resolved on-disk path, falling back to the anchor's cached path, or `null` when the anchor row is missing. */
export function resolvedPathOrCached(r: ResolvedAnchor | null): string | null {
    return r ? (r.path ?? r.anchor.cachedPath) : null;
}

async function selfHeal(anchor: Anchor, anchorId: string, dir: string): Promise<Result<ResolvedAnchor, DbError>> {
    const canonical = await canonicalPathAsync(dir);
    const healed: Anchor = { ...anchor, cachedPath: canonical };
    return updateAnchorCachedPath(anchorId, canonical).map(() => ({ anchor: healed, path: canonical }));
}

/**
 * How many marker reads of the bounded search run at one time. Each candidate costs one `stat` (and one read
 * on a hit), and the candidate set grows with the count of known anchors. The width keeps that set from
 * flooding the libuv thread pool that each other request of the server shares, and a folder on a hung mount
 * holds one slot, not the whole search.
 */
const MARKER_READ_WIDTH = 8;

/**
 * The bounded searches that found no folder and read each candidate, for the life of the server: for each anchor
 * id, the key of the candidate set of each miss. A search with an unknown candidate is no miss: the folder can
 * answer later. The search reads the marker of each known anchor folder and of each parent of
 * the roots, and a poll of an analysis whose folder is gone would run it again at each tick. A later search of
 * the same anchor over the same candidates is skipped and gives `path: null`. A new root or a new anchor folder
 * changes the candidates, thus it searches again. Steps 1 and 2 still run, thus a folder that comes back at its
 * cached path, or under the roots, still resolves, and that resolve drops the misses of its anchor.
 */
const searchMisses = new Map<string, Set<string>>();

/** Drop the remembered search misses of `anchorIds`, for an anchor whose row is gone. */
export function forgetSearchMisses(anchorIds: readonly string[]): void {
    for (const id of anchorIds) searchMisses.delete(id);
}

/**
 * Resolve a UUID to its current path, reconciling the cached path lazily. See the spec
 * (Folder identity & moves): cached-path check → cwd/ancestor self-heal → bounded search.
 *
 * Returns `null` when the DB has no row for `anchorId`. That is a NORMAL condition, not an error:
 * the database is the user's local file and they may delete or edit it freely, while on-disk markers
 * (and analyses that reference an anchor) persist independently — so a reference to a missing anchor
 * is a routine desync. We degrade rather than hard-fail; the deliberate `getOrCreateAnchorForCwd`
 * re-establishes the row from the on-disk marker when the user next acts (we never write on this
 * passive resolve — the no-litter policy). See CLAUDE.md → "Local state can desync from the database".
 *
 * `touch` records a sighting heartbeat on the happy path. Leave it on for a user-driven resolve
 * (launch, context, `open`), where a sighting is real news. Turn it OFF for resolves the user did
 * not ask for — notably the harness's workspace-root lookup, which runs once per agent file read:
 * `last_seen` would then measure agent I/O rather than folder liveness, and each read would pay a
 * synchronous SQLite write.
 *
 * The disk reads run off the event loop, and the SQLite reads and writes stay synchronous.
 */
export function resolveAnchor(anchorId: string, opts?: { searchRoots?: string[]; touch?: boolean }): ResultAsync<ResolvedAnchor | null, DbError> {
    return new ResultAsync(resolveAnchorPath(anchorId, opts));
}

async function resolveAnchorPath(anchorId: string, opts?: { searchRoots?: string[]; touch?: boolean }): Promise<Result<ResolvedAnchor | null, DbError>> {
    const touch = opts?.touch ?? true;
    const found = getAnchor(anchorId);
    if (found.isErr()) return err(found.error);
    const anchor = found.value;
    if (!anchor) return ok(null);

    // Step 1: the cached path still holds our marker — cheapest, highest-hit case.
    const cached = await probeMarker(anchor.cachedPath, anchorId);
    if (cached === "match") {
        searchMisses.delete(anchorId);
        const resolved: ResolvedAnchor = { anchor, path: anchor.cachedPath };
        return touch ? touchAnchor(anchorId).map(() => resolved) : ok(resolved);
    }
    // The cached path can still hold the marker: a hit anywhere else can be a copy, thus nothing heals.
    if (cached === "unknown") return ok({ anchor, path: null });

    const roots = await Promise.all((opts?.searchRoots ?? [process.cwd()]).map((r) => canonicalPathAsync(r)));

    // Step 2: cwd or an ancestor holds our marker (we cd'd into the moved folder).
    for (const root of roots) {
        const hit = await findMatchingMarkerUpwards(root, anchorId);
        if (hit) {
            searchMisses.delete(anchorId);
            return selfHeal(anchor, anchorId, hit);
        }
    }

    // Step 3: bounded search over roots (+ ancestors) and known anchor cached paths.
    const anchors = listAnchors();
    if (anchors.isErr()) return err(anchors.error);
    const candidates = new Set<string>();
    for (const root of roots) for (const d of ancestorsOf(root)) candidates.add(d);
    for (const a of anchors.value) candidates.add(resolve(a.cachedPath));
    const ordered = [...candidates];
    // Sorted, thus the key does not change with the order of the rows.
    const key = [...ordered].sort().join("\0");
    if (searchMisses.get(anchorId)?.has(key)) return ok({ anchor, path: null });

    // Each candidate is read, with no stop at the first hit: a second match must be seen to refuse a guess.
    const queue = new PQueue({ concurrency: MARKER_READ_WIDTH });
    const probes = await Promise.all(ordered.map((d) => queue.add(() => probeMarker(d, anchorId))));
    // An unknown candidate can be a second match, thus one hit is not unique, and the search is no miss.
    if (probes.includes("unknown")) return ok({ anchor, path: null });
    const matches = ordered.filter((_, i) => probes[i] === "match");
    const unique = matches.length === 1 ? matches[0] : null;
    if (unique) return selfHeal(anchor, anchorId, unique);
    // Zero or multiple hits: do not guess — caller surfaces "run `inflexa relocate`".
    const misses = searchMisses.get(anchorId) ?? new Set<string>();
    misses.add(key);
    searchMisses.set(anchorId, misses);
    return ok({ anchor, path: null });
}

/**
 * What a marker sighting at a folder is. `copy`: `original` is the known folder of the anchor, and it still holds
 * the same marker. `unverified`: the read of `original` did not answer, thus the sighting can be a copy or a move.
 */
export type MarkerSighting = { kind: "ok" } | { kind: "move" } | { kind: "copy"; original: string } | { kind: "unverified"; original: string };

/**
 * Classify a marker sighting at `dir` against the UUID's known location. Only classifies;
 * callers own the UX and never auto-merge a copy.
 */
export function classifyMarkerSighting(dir: string, marker: AnchorMarker): ResultAsync<MarkerSighting, DbError> {
    return new ResultAsync(classifySighting(dir, marker));
}

async function classifySighting(dir: string, marker: AnchorMarker): Promise<Result<MarkerSighting, DbError>> {
    const abs = await canonicalPathAsync(dir);
    const anchor = getAnchor(marker.anchorId);
    if (anchor.isErr()) return err(anchor.error);
    if (!anchor.value) return ok({ kind: "ok" }); // no existing identity to conflict with
    const cached = await canonicalPathAsync(anchor.value.cachedPath);
    if (cached === abs) return ok({ kind: "ok" });
    // A folder that exists at the cached path is not proof of a copy: a moved project can leave a new, empty
    // folder at its old path. Only the same marker there makes `dir` a copy.
    const probe = await probeMarker(cached, marker.anchorId);
    switch (probe) {
        case "match":
            return ok({ kind: "copy", original: cached });
        case "unknown":
            return ok({ kind: "unverified", original: cached });
        case "no_match":
            return ok({ kind: "move" });
        default: {
            const exhaustive: never = probe;
            throw new Error(`unhandled marker probe: ${JSON.stringify(exhaustive)}`);
        }
    }
}

/** Why a copied folder got no new identity. `not_a_copy`: the folder holds no marker, or its marker is not a copy of a tracked folder. */
export type NewIdentityError =
    | { type: "marker_unreadable"; dir: string; cause: MarkerError }
    | { type: "not_a_copy"; dir: string }
    | { type: "original_unverified"; dir: string; original: string }
    | { type: "marker_write_failed"; dir: string; cause: MarkerError }
    | { type: "db_failed"; cause: DbError };

/** What a new identity did: the copy at `path` now has the anchor `anchorId`, and the original keeps `previousAnchorId`. */
export type NewIdentityOutcome = { anchorId: string; previousAnchorId: string; path: string; original: string };

/**
 * Give a copied folder its own identity: a new marker UUID and a new anchor row at the folder. The original keeps
 * its marker, its row, and its analyses. A deliberate user action, thus it writes the marker (no-litter policy).
 *
 * The marker is written before the row: a failed insert then leaves a marker with no row, the routine desync
 * that the next deliberate action recovers, and never a row whose folder still holds the marker of the original.
 */
export function giveCopyNewIdentity(path: string): ResultAsync<NewIdentityOutcome, NewIdentityError> {
    return new ResultAsync(
        canonicalPathAsync(path).then((dir) => {
            // One at a time for each folder: two clients that both see the copy would each mint an id, and the
            // second marker would orphan the row of the first. The second runs after the first, and it finds no copy.
            const run = (identityRuns.get(dir) ?? Promise.resolve()).then(() => newIdentity(dir));
            identityRuns.set(dir, run);
            void run.finally(() => {
                if (identityRuns.get(dir) === run) identityRuns.delete(dir);
            });
            return run;
        }),
    );
}

/** The new identity that runs for each canonical folder, the tail of its queue. */
const identityRuns = new Map<string, Promise<Result<NewIdentityOutcome, NewIdentityError>>>();

async function newIdentity(dir: string): Promise<Result<NewIdentityOutcome, NewIdentityError>> {
    const marker = await readMarker(dir);
    if (marker.isErr()) return err({ type: "marker_unreadable", dir, cause: marker.error });
    if (marker.value === null) return err({ type: "not_a_copy", dir });
    const previousAnchorId = marker.value.anchorId;
    const sighting = await classifySighting(dir, marker.value);
    if (sighting.isErr()) return err({ type: "db_failed", cause: sighting.error });
    if (sighting.value.kind === "unverified") return err({ type: "original_unverified", dir, original: sighting.value.original });
    if (sighting.value.kind !== "copy") return err({ type: "not_a_copy", dir });
    const original = sighting.value.original;

    const anchorId = randomUUIDv7();
    const written = await replaceMarker(dir, anchorId);
    if (written.isErr()) return err({ type: "marker_write_failed", dir, cause: written.error });
    return insertAnchor(await makeAnchor(anchorId, dir, true))
        .map((): NewIdentityOutcome => ({ anchorId, previousAnchorId, path: dir, original }))
        .mapErr((cause): NewIdentityError => ({ type: "db_failed", cause }));
}

/**
 * Reconcile every known anchor against the filesystem — the automatic counterpart to the
 * manual `repair`/`relocate`/`prune` backstop, meant to run in the background after a launch. An anchor still at
 * its cached path is a cheap no-op (a heartbeat touch); one whose folder moved under
 * `searchRoots` self-heals in place; one that cannot be located is left untouched for the
 * operator to `relocate` or `prune`. Recovery only — it never mints or writes a marker.
 * Returns how many anchors resolved to a live path (`recovered`) versus could not
 * (`unresolved`), so the caller can log a one-line summary.
 *
 * The anchors resolve one at a time: each resolve can run a bounded search of its own, and a
 * second level of width would multiply the reads in flight.
 */
export function recoverAnchors(searchRoots: string[] = [process.cwd()]): ResultAsync<{ recovered: number; unresolved: number }, DbError> {
    return listAnchors().asyncAndThen((anchors) => new ResultAsync(recoverEach(anchors, searchRoots)));
}

async function recoverEach(anchors: readonly Anchor[], searchRoots: string[]): Promise<Result<{ recovered: number; unresolved: number }, DbError>> {
    // Each anchor gets its resolve even after a failure, and the first failure is the answer.
    let failure: DbError | null = null;
    let recovered = 0;
    for (const a of anchors) {
        const resolved = await resolveAnchor(a.id, { searchRoots });
        if (resolved.isErr()) failure ??= resolved.error;
        // Every id comes from listAnchors, so the row always exists (the value is non-null); a null
        // would count as unresolved anyway.
        else if (resolved.value?.path != null) recovered++;
    }
    if (failure !== null) return err(failure);
    return ok({ recovered, unresolved: anchors.length - recovered });
}
