import { randomUUIDv7 } from "bun";
import { sep } from "node:path";
import type { Result } from "neverthrow";
import { tryMutation, withTransaction } from "./util.ts";
import type { TransferKind } from "../types/store.ts";
import type { DbError } from "./errors.ts";
import type { Anchor } from "../types/anchor.ts";
import type { Project } from "../types/project.ts";
import type { Analysis, AnalysisInput } from "../types/analysis.ts";
import type { Str256 } from "../lib/types.ts";

/**
 * Mints and persists a new project. A duplicate `name` trips the `UNIQUE` constraint and
 * surfaces as `constraint_violation` (`unique`) for the caller to translate.
 */
export function createProject(input: { name: Str256; description: string | null; tags: string[] }): Result<Project, DbError> {
    const now = Date.now();
    const project: Project = {
        id: randomUUIDv7(),
        createdAt: now,
        updatedAt: now,
        name: input.name,
        description: input.description,
        tags: input.tags,
    };
    return tryMutation("createProject", (conn) => {
        conn.query("INSERT INTO projects (id, created_at, updated_at, name, description, tags) VALUES (?, ?, ?, ?, ?, ?)").run(
            project.id,
            project.createdAt,
            project.updatedAt,
            project.name,
            project.description,
            // tags hold no commas (comma-split on input), so a comma-join round-trips losslessly.
            project.tags.join(","),
        );
        return project;
    });
}

/**
 * Inserts a fully-formed anchor row. The caller supplies the id — rather than this
 * minting one like {@link createProject} — because an anchor's id is its write-once
 * marker id, which may already exist on disk and must be preserved, not regenerated.
 */
export function insertAnchor(anchor: Anchor): Result<Anchor, DbError> {
    return tryMutation("insertAnchor", (conn) => {
        conn.query("INSERT INTO anchors (id, created_at, updated_at, cached_path, marker_written, last_seen) VALUES (?, ?, ?, ?, ?, ?)").run(
            anchor.id,
            anchor.createdAt,
            anchor.updatedAt,
            anchor.cachedPath,
            anchor.markerWritten ? 1 : 0,
            anchor.lastSeen,
        );
        return anchor;
    });
}

/** Re-points an anchor at `cachedPath`. A real data edit, so it bumps `updatedAt`; the `lastSeen` heartbeat stays separate. Returns rows changed — `0` when no such anchor exists. */
export function updateAnchorCachedPath(id: string, cachedPath: string): Result<number, DbError> {
    return tryMutation("updateAnchorCachedPath", (conn) => {
        return conn.query("UPDATE anchors SET cached_path = ?, updated_at = ? WHERE id = ?").run(cachedPath, Date.now(), id).changes;
    });
}

/** Records a sighting heartbeat (`lastSeen`) only — deliberately does NOT touch `updatedAt`, the data-edit timestamp. Returns rows changed — `0` when no such anchor exists. */
export function touchAnchor(id: string): Result<number, DbError> {
    return tryMutation("touchAnchor", (conn) => {
        return conn.query("UPDATE anchors SET last_seen = ? WHERE id = ?").run(Date.now(), id).changes;
    });
}

/** Drops an anchor row by its id. Returns rows changed — `0` when no such row exists. */
export function deleteAnchor(id: string): Result<number, DbError> {
    return tryMutation("deleteAnchor", (conn) => {
        return conn.query("DELETE FROM anchors WHERE id = ?").run(id).changes;
    });
}

// --- Data model: analyses ---

/** Inserts a fully-formed analysis row. The caller mints the id (`randomUUIDv7()`) and resolves the slug before calling. */
export function insertAnalysis(analysis: Analysis): Result<Analysis, DbError> {
    return tryMutation("insertAnalysis", (conn) => {
        conn.query("INSERT INTO analyses (id, created_at, updated_at, name, slug, anchor_id, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            analysis.id,
            analysis.createdAt,
            analysis.updatedAt,
            analysis.name,
            analysis.slug,
            analysis.anchorId,
            analysis.projectId,
        );
        return analysis;
    });
}

/** Attaches/moves/clears an analysis's project grouping in one targeted write (bumps `updated_at`). Returns rows changed — `0` when no such analysis exists. */
export function updateAnalysisProject(id: string, projectId: string | null): Result<number, DbError> {
    return tryMutation("updateAnalysisProject", (conn) => {
        return conn.query("UPDATE analyses SET project_id = ?, updated_at = ? WHERE id = ?").run(projectId, Date.now(), id).changes;
    });
}

/** Inserts a single input ref for an analysis. */
export function insertAnalysisInput(input: AnalysisInput): Result<AnalysisInput, DbError> {
    return tryMutation("insertAnalysisInput", (conn) => {
        conn.query("INSERT INTO analysis_inputs (path, is_dir, analysis_id, anchor_id) VALUES (?, ?, ?, ?)").run(
            input.path,
            input.isDir ? 1 : 0,
            input.analysisId,
            input.anchorId,
        );
        return input;
    });
}

/**
 * Removes a single input ref, matched by its identity (owning analysis + path + source anchor).
 * `anchor_id` is matched with `IS` so a `null` (raw path) ref compares equal. Returns rows
 * deleted — `0` when no such ref exists.
 */
export function deleteAnalysisInput(input: AnalysisInput): Result<number, DbError> {
    return tryMutation("deleteAnalysisInput", (conn) => {
        return conn.query("DELETE FROM analysis_inputs WHERE analysis_id = ? AND path = ? AND anchor_id IS ?").run(input.analysisId, input.path, input.anchorId)
            .changes;
    });
}

/** Deletes every analysis homed at an anchor (their input refs cascade via the analysis FK). Used by `prune` before dropping a dead anchor, since the analyses→anchors FK has no ON DELETE CASCADE. Returns rows deleted. */
export function deleteAnalysesForAnchor(anchorId: string): Result<number, DbError> {
    return tryMutation("deleteAnalysesForAnchor", (conn) => {
        return conn.query("DELETE FROM analyses WHERE anchor_id = ?").run(anchorId).changes;
    });
}

/** Deletes a single analysis by id. Its `analysis_inputs` cascade via the FK. Returns rows deleted from analyses — `0` when no such row exists. */
export function deleteAnalysis(id: string): Result<number, DbError> {
    return tryMutation("deleteAnalysis", (conn) => {
        return conn.query("DELETE FROM analyses WHERE id = ?").run(id).changes;
    });
}

/** Deletes a project by id. Analyses referencing it are NOT deleted — their `project_id` is NULLed so they become ungrouped. Returns rows deleted — `0` when no such row exists. */
export function deleteProject(id: string): Result<number, DbError> {
    return withTransaction("deleteProject", () =>
        tryMutation("deleteProject.unlink", (conn) => {
            conn.query("UPDATE analyses SET project_id = NULL, updated_at = ? WHERE project_id = ?").run(Date.now(), id);
        }).andThen(() =>
            tryMutation("deleteProject.delete", (conn) => {
                return conn.query("DELETE FROM projects WHERE id = ?").run(id).changes;
            }),
        ),
    );
}

/** Renames an analysis and regenerates its slug. The caller provides the new name + slug. Returns rows changed — `0` when no such analysis exists. */
export function renameAnalysis(id: string, name: Str256, slug: string): Result<number, DbError> {
    return tryMutation("renameAnalysis", (conn) => {
        return conn.query("UPDATE analyses SET name = ?, slug = ?, updated_at = ? WHERE id = ?").run(name, slug, Date.now(), id).changes;
    });
}

/** Updates a project's mutable fields (name, description, tags). Returns rows changed — `0` when no such project exists. */
export function updateProject(id: string, opts: { name: Str256; description: string | null; tags: string[] }): Result<number, DbError> {
    return tryMutation("updateProject", (conn) => {
        return conn
            .query("UPDATE projects SET name = ?, description = ?, tags = ?, updated_at = ? WHERE id = ?")
            .run(opts.name, opts.description, opts.tags.join(","), Date.now(), id).changes;
    });
}

/**
 * Rewrites the path prefix of every raw (anchor-less) input under a moved tree
 * (`fromPrefix` → `toPrefix`). Anchor-relative inputs already ride their anchor's reconciled
 * location, so only `anchor_id IS NULL` rows need this. Returns how many paths were rewritten.
 */
export function relocateRawInputPrefix(fromPrefix: string, toPrefix: string): Result<number, DbError> {
    return tryMutation("relocateRawInputPrefix", (conn) => {
        const rows = conn.query("SELECT rowid, path FROM analysis_inputs WHERE anchor_id IS NULL AND path LIKE ?").all(`${fromPrefix}%`) as {
            rowid: number;
            path: string;
        }[];
        let rewritten = 0;
        for (const r of rows) {
            // `LIKE 'prefix%'` can match a sibling (`/a/bc` under `/a/b`); only rewrite a true
            // path-boundary match — the prefix exactly, or followed by a separator.
            if (r.path === fromPrefix || r.path.startsWith(fromPrefix + sep)) {
                conn.query("UPDATE analysis_inputs SET path = ? WHERE rowid = ?").run(toPrefix + r.path.slice(fromPrefix.length), r.rowid);
                rewritten++;
            }
        }
        return rewritten;
    });
}

// --- Data model: LLM usage ledger ---

/**
 * What a provider reported for ONE call, named for the harness `ChatUsage` fields it carries.
 *
 * Every quantity is independently optional and an absent one means "not reported", never zero — a
 * provider that reports totals without a cache breakdown is legitimate, and flattening that to `0`
 * would turn an unknown into a measurement. The five are NOT addable: cache-creation, cache-read, and
 * reasoning counts are breakdowns *of* the input and output counts, so nothing here or downstream
 * combines them into a single figure.
 */
export type LlmUsageTokens = {
    inputTokens?: number;
    outputTokens?: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    reasoningTokens?: number;
};

/** One ledger row as the storage layer takes it — the harness's `LlmUsageRecord` already flattened to columns by its caller. */
export type LlmUsageEntry = {
    /** The harness's idempotency key, stable across every replay of the same call. It is the row's whole identity. */
    recordKey: string;
    /**
     * When the record was observed, epoch millis. The harness stamps no time on a record (its own
     * decision), so arrival at this sink is the only clock available — the caller stamps `Date.now()`
     * as it hands the record over. An upsert of an existing key deliberately leaves the stored value
     * alone, so the ledger's time axis records when the work happened, not when a replay re-delivered it.
     */
    recordedAt: number;
    /** The agent that made the call — a sub-agent records under its own id. */
    agentId: string;
    /** The record's provenance path, already joined into one string by the caller. */
    callPath: string;
    /** The harness `Scope` discriminant, stored so both variants stay representable (`"analysis"` | `"target-assessment"`). */
    scopeKind: string;
    /** The scoped workload id. Not a foreign key: it may name a workload this database never held. */
    scopeId: string;
    threadId?: string;
    runId?: string;
    stepId?: string;
    requestedModelId?: string;
    servedModelId?: string;
    usage: LlmUsageTokens;
};

/**
 * Persists one usage record, upserting on the harness's `recordKey`.
 *
 * The harness guarantees key stability, NOT at-most-once delivery: a replayed durable workflow body
 * re-fires `record` with a byte-identical key, so this must never insert a second row or fail on the
 * clash. `DO UPDATE` over `DO NOTHING` follows the seam's contract literally — on a pure replay the
 * two are equivalent (the replayed body reports the cached call's identical figures), but on a genuine
 * step retry that re-executes the call for real, last-writer-wins reflects the retry's actual spend
 * where `DO NOTHING` would pin the abandoned attempt's.
 *
 * `recorded_at` is deliberately absent from the conflict update (see {@link LlmUsageEntry.recordedAt}),
 * as is the attribution — the same key is the same call, so its agent, path, scope, and frame cannot
 * have changed. Unreported token quantities bind as SQL NULL, never `0`.
 */
export function upsertLlmUsage(entry: LlmUsageEntry): Result<void, DbError> {
    return tryMutation("upsertLlmUsage", (conn) => {
        conn.query(
            `INSERT INTO llm_usage (
                 record_key, recorded_at, agent_id, call_path, scope_kind, scope_id,
                 thread_id, run_id, step_id, requested_model_id, served_model_id,
                 input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, reasoning_tokens
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(record_key) DO UPDATE SET
                 requested_model_id = excluded.requested_model_id,
                 served_model_id = excluded.served_model_id,
                 input_tokens = excluded.input_tokens,
                 output_tokens = excluded.output_tokens,
                 cache_creation_input_tokens = excluded.cache_creation_input_tokens,
                 cache_read_input_tokens = excluded.cache_read_input_tokens,
                 reasoning_tokens = excluded.reasoning_tokens`,
        ).run(
            entry.recordKey,
            entry.recordedAt,
            entry.agentId,
            entry.callPath,
            entry.scopeKind,
            entry.scopeId,
            // `?? null` on every optional: bun:sqlite binds `null` as SQL NULL but rejects `undefined`,
            // and NULL is precisely the "not reported" the ledger must preserve.
            entry.threadId ?? null,
            entry.runId ?? null,
            entry.stepId ?? null,
            entry.requestedModelId ?? null,
            entry.servedModelId ?? null,
            entry.usage.inputTokens ?? null,
            entry.usage.outputTokens ?? null,
            entry.usage.cacheCreationInputTokens ?? null,
            entry.usage.cacheReadInputTokens ?? null,
            entry.usage.reasoningTokens ?? null,
        );
    });
}

// --- Data model: provenance ---

/**
 * Persists the PROV-JSON serialization of an analysis's provenance document and its integrity
 * columns. All three are required — unsigned provenance is never written (the signing key is
 * generated on first use, so absence is a hard fault, not a graceful-degradation case). The
 * UPDATE atomically rotates the chain: the current `provenance_chain_hash` becomes
 * `provenance_prev_chain_hash` before the new values land, so the verifier can always recompute
 * `chainHash = SHA-256(prevChainHash || provJson)` from stored data alone. Deliberately does NOT
 * bump `updated_at`: provenance is recorded metadata flushed asynchronously, not a user data-edit
 * — the same reasoning as `touchAnchor` leaving `updatedAt` alone. Returns rows changed.
 */
export function updateAnalysisProvenance(id: string, provenance: string, chainHash: string, signature: string): Result<number, DbError> {
    return tryMutation("updateAnalysisProvenance", (conn) => {
        return conn
            .query(
                `UPDATE analyses
                 SET provenance = ?,
                     provenance_prev_chain_hash = provenance_chain_hash,
                     provenance_chain_hash = ?,
                     provenance_signature = ?
                 WHERE id = ?`,
            )
            .run(provenance, chainHash, signature, id).changes;
    });
}

// --- Data model: the package-store transfers ---

/**
 * Begin a transfer run of one kind: reset every counter and write the starting state.
 *
 * Every counter resets here, because a run always begins with nothing transferred and the totals stay
 * absent until the resolve. This is the write that leaves a terminal state: `failed`, `declined`, and
 * `canceled` all move to `pending` through it, which is the retry the lifecycle permits.
 *
 * An upsert, because the very first run on a machine has no row and a retry rewrites the row it has.
 */
export function startTransferRun(kind: TransferKind, params: { state: "pending" | "running"; holderPid: number | null }): Result<void, DbError> {
    const now = Date.now();
    return tryMutation("startTransferRun", (conn) => {
        conn.query(
            `INSERT INTO transfers (
                 id, created_at, updated_at, state, bytes_transferred, total_bytes,
                 layers_completed, total_layers, digest, message, holder_pid
             )
             VALUES (?, ?, ?, ?, 0, NULL, 0, NULL, NULL, NULL, ?)
             ON CONFLICT(id) DO UPDATE SET
                 updated_at = excluded.updated_at,
                 state = excluded.state,
                 bytes_transferred = 0,
                 total_bytes = NULL,
                 layers_completed = 0,
                 total_layers = NULL,
                 digest = NULL,
                 message = NULL,
                 holder_pid = excluded.holder_pid`,
        ).run(kind, now, now, params.state, params.holderPid);
    });
}

/**
 * Record what the resolve of a transfer declares: its digest, and the exact totals when the source
 * states them.
 *
 * Written ONE time for each run, at the moment the source resolves. A catalog manifest declares the
 * size of every layer before the first byte arrives, so neither total is an estimate. An image pull
 * declares no byte total, and the two totals then stay NULL.
 *
 * A pure UPDATE, never an insert. A resolve that finds the machine up to date must not mint a row for
 * a kind that no transfer ever ran — such a kind reports "no transfer ran", which is the truth.
 * Returns rows changed: `0` when there is no row to annotate.
 */
export function recordTransferResolve(
    kind: TransferKind,
    params: { digest: string; totalBytes: number | null; totalLayers: number | null },
): Result<number, DbError> {
    return tryMutation("recordTransferResolve", (conn) => {
        return conn
            .query("UPDATE transfers SET updated_at = ?, total_bytes = ?, total_layers = ?, digest = ? WHERE id = ?")
            .run(Date.now(), params.totalBytes, params.totalLayers, params.digest, kind).changes;
    });
}

/** Record how far the live transfer has moved. Returns rows changed — `0` when no run holds the row. */
export function recordTransferProgress(kind: TransferKind, params: { bytesTransferred: number; layersCompleted: number }): Result<number, DbError> {
    return tryMutation("recordTransferProgress", (conn) => {
        return conn
            .query("UPDATE transfers SET updated_at = ?, bytes_transferred = ?, layers_completed = ? WHERE id = ?")
            .run(Date.now(), params.bytesTransferred, params.layersCompleted, kind).changes;
    });
}

/**
 * Settle a transfer in a terminal state, and release the holder.
 *
 * `holder_pid` clears here because the child is over in every one of the four cases, and a stale pid
 * would name a process that a later cancel must not signal.
 *
 * An upsert, because `declined` records a setup answer of no on a machine that has no row yet.
 */
export function settleTransfer(
    kind: TransferKind,
    params: { state: "installed" | "failed" | "declined" | "canceled"; message: string | null },
): Result<void, DbError> {
    const now = Date.now();
    return tryMutation("settleTransfer", (conn) => {
        conn.query(
            `INSERT INTO transfers (
                 id, created_at, updated_at, state, bytes_transferred, total_bytes,
                 layers_completed, total_layers, digest, message, holder_pid
             )
             VALUES (?, ?, ?, ?, 0, NULL, 0, NULL, NULL, ?, NULL)
             ON CONFLICT(id) DO UPDATE SET
                 updated_at = excluded.updated_at,
                 state = excluded.state,
                 message = excluded.message,
                 holder_pid = NULL`,
        ).run(kind, now, now, params.state, params.message);
    });
}

// --- Data model: the package-store acquisition flights ---

/**
 * Claim the flight for one normalized spec, and report whether this process owns it.
 *
 * The upsert IS the single-flight decision, in one atomic statement, thus two processes — and two
 * calls inside one process — cannot both own the flight for a key. `true` means "this call owns the
 * flight and must run the work"; `false` means "a flight is already live, thus subscribe to it".
 *
 * A `failed` row is a terminal record, not a live flight: the conflict branch flips it back to
 * `queued`, clears its message, and hands the key to this caller. Thus a retry of the same spec
 * claims the same row, and the recorded failure clears with the retry. Only a live row refuses.
 *
 * A claimed row starts `queued`, never `running`: a slot under the concurrency cap is a second
 * decision, and {@link promoteStoreFlight} makes it.
 */
export function claimStoreFlight(params: {
    id: string;
    ecosystem: "python" | "r" | null;
    name: string;
    specifier: string;
    holderPid: number;
}): Result<boolean, DbError> {
    const now = Date.now();
    return tryMutation("claimStoreFlight", (conn) => {
        return (
            conn
                .query(
                    `INSERT INTO package_store_flights (
                     id, created_at, updated_at, state, ecosystem, name, specifier, progress, message, holder_pid
                 )
                 VALUES (?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, ?)
                 ON CONFLICT(id) DO UPDATE SET
                     created_at = excluded.created_at,
                     updated_at = excluded.updated_at,
                     state = 'queued',
                     progress = NULL,
                     message = NULL,
                     holder_pid = excluded.holder_pid
                 WHERE package_store_flights.state = 'failed'`,
                )
                .run(params.id, now, now, params.ecosystem, params.name, params.specifier, params.holderPid).changes === 1
        );
    });
}

/**
 * Settle a flight as `failed`, with the reason the surfaces render. Returns rows changed.
 *
 * The message holds the WHOLE error text behind its phase — the row is the one durable copy after
 * the debris pass collects the report file, thus a truncation here would destroy the trace. The
 * surfaces bound the render instead. The progress clears, because a terminal row reports a reason,
 * not a live line.
 */
export function settleStoreFlightFailure(params: { id: string; message: string }): Result<number, DbError> {
    return tryMutation("settleStoreFlightFailure", (conn) => {
        return conn
            .query("UPDATE package_store_flights SET updated_at = ?, state = 'failed', progress = NULL, message = ? WHERE id = ?")
            .run(Date.now(), params.message, params.id).changes;
    });
}

/**
 * Move a queued flight to `running`, but only while fewer than `cap` flights already run.
 *
 * The cap lives in the WHERE clause rather than in a read-then-decide pair, because two owners that each
 * read the count and then wrote would both pass a cap of one. One statement is one write transaction, so
 * the count and the promotion cannot straddle another writer. Returns rows changed: `0` means that every
 * slot is taken, thus the caller waits and asks again.
 */
export function promoteStoreFlight(params: { id: string; cap: number }): Result<number, DbError> {
    return tryMutation("promoteStoreFlight", (conn) => {
        return conn
            .query(
                `UPDATE package_store_flights SET updated_at = ?, state = 'running'
                 WHERE id = ? AND state = 'queued'
                   AND (SELECT COUNT(*) FROM package_store_flights WHERE state = 'running') < ?`,
            )
            .run(Date.now(), params.id, params.cap).changes;
    });
}

/** Record the newest provisioner line of a live flight, so a subscriber reports the same progress. Returns rows changed. */
export function recordStoreFlightProgress(params: { id: string; progress: string }): Result<number, DbError> {
    return tryMutation("recordStoreFlightProgress", (conn) => {
        return conn.query("UPDATE package_store_flights SET updated_at = ?, progress = ? WHERE id = ?").run(Date.now(), params.progress, params.id).changes;
    });
}

/**
 * Remove a flight row, with its subscriptions.
 *
 * This is how a flight ends, in every outcome. A finished flight is not a cache: a row that survived a
 * failure would dedup the next request for the same spec against work that never landed. The
 * subscriptions go with it through the cascade. It is also the sweep of debris that a killed owner left.
 */
export function deleteStoreFlight(id: string): Result<number, DbError> {
    return tryMutation("deleteStoreFlight", (conn) => {
        return conn.query("DELETE FROM package_store_flights WHERE id = ?").run(id).changes;
    });
}

/**
 * Subscribe an analysis to a live flight, or record the terminal subscription that belongs to no analysis.
 *
 * `analysisId` of `null` is the plain `inflexa store add` in a terminal: it keeps the flight alive and it
 * has no farm to extend. A second subscription of the same subscriber is a no-op, because a request that
 * repeats must not make the flight outlive one cancel for each repeat.
 */
export function subscribeStoreFlight(params: { flightId: string; analysisId: string | null }): Result<number, DbError> {
    return tryMutation("subscribeStoreFlight", (conn) => {
        return conn
            .query("INSERT OR IGNORE INTO package_store_flight_subscriptions (flight_id, analysis_id) VALUES (?, ?)")
            .run(params.flightId, params.analysisId).changes;
    });
}

/**
 * Remove one subscription. Returns rows changed: `0` when that subscriber was not subscribed.
 *
 * A cancel removes one subscription and never the flight. The flight stops when the count reaches zero,
 * and its owner is what reads that count — refer to `countStoreFlightSubscribers`.
 *
 * The two branches are one statement each rather than `analysis_id IS ?`, because SQLite compares a bound
 * NULL with `=` as unknown, thus the terminal subscription would never match.
 */
export function unsubscribeStoreFlight(params: { flightId: string; analysisId: string | null }): Result<number, DbError> {
    return tryMutation("unsubscribeStoreFlight", (conn) => {
        return params.analysisId === null
            ? conn.query("DELETE FROM package_store_flight_subscriptions WHERE flight_id = ? AND analysis_id IS NULL").run(params.flightId).changes
            : conn.query("DELETE FROM package_store_flight_subscriptions WHERE flight_id = ? AND analysis_id = ?").run(params.flightId, params.analysisId)
                  .changes;
    });
}

// --- Data model: the pending set of `inflexa store add` ---

/**
 * Enqueue one approved add into the pending set.
 *
 * A repeat of one spec for one analysis stays one entry: the flush deduplicates by the flight key
 * anyway, and the queue is a readout the surfaces render, thus a doubled line would only mislead.
 * The dedup rides in the WHERE of the one insert rather than a UNIQUE constraint, because
 * `analysis_id` is nullable and the pair of partial indexes would outweigh a queue this small.
 * `IS ?` carries the two nullable columns, thus a NULL binding compares as a value and the one
 * statement covers every case with no read-then-decide race between two writers.
 */
export function enqueuePendingStoreAdd(params: {
    name: string;
    specifier: string;
    ecosystem: "python" | "r" | null;
    analysisId: string | null;
}): Result<void, DbError> {
    const now = Date.now();
    return tryMutation("enqueuePendingStoreAdd", (conn) => {
        conn.query(
            "INSERT INTO pending_store_adds (id, created_at, name, specifier, ecosystem, analysis_id) " +
                "SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (" +
                "SELECT 1 FROM pending_store_adds WHERE name = ? AND specifier = ? AND ecosystem IS ? AND analysis_id IS ?)",
        ).run(
            randomUUIDv7(),
            now,
            params.name,
            params.specifier,
            params.ecosystem,
            params.analysisId,
            params.name,
            params.specifier,
            params.ecosystem,
            params.analysisId,
        );
    });
}

/**
 * Take the whole pending set, atomically: read every entry and delete them in one transaction.
 *
 * The claim is what makes two flushers safe: the second one reads an empty set and runs nothing. An
 * entry that arrives after the claim belongs to the next flush, which is exactly the batch boundary
 * the grace protects.
 */
export function claimPendingStoreAdds(): Result<
    { id: string; createdAt: number; name: string; specifier: string; ecosystem: "python" | "r" | null; analysisId: string | null }[],
    DbError
> {
    return tryMutation("claimPendingStoreAdds", (conn) => {
        const take = conn.transaction(() => {
            const rows = conn.query("SELECT id, created_at, name, specifier, ecosystem, analysis_id FROM pending_store_adds ORDER BY created_at, id").all() as {
                id: string;
                created_at: number;
                name: string;
                specifier: string;
                ecosystem: "python" | "r" | null;
                analysis_id: string | null;
            }[];
            conn.query("DELETE FROM pending_store_adds").run();
            return rows;
        });
        return take().map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            name: r.name,
            specifier: r.specifier,
            ecosystem: r.ecosystem,
            analysisId: r.analysis_id,
        }));
    });
}

/**
 * Move a whole batch of queued flights to `running`, but only while the count of OTHER live acquire
 * runs stays under `cap`.
 *
 * The cap bounds concurrent provisioner RUNS, not rows: one flush promotes its whole batch as one
 * run. The distinct holder pids of the running rows count the runs, and the batch's own pid is
 * excluded so a retry of a half-promoted batch cannot block itself. One statement, so the count and
 * the promotion cannot straddle another writer. Returns rows changed: fewer than the batch size
 * means that every slot is taken, and the caller waits and asks again.
 */
export function promoteStoreFlightBatch(params: { ids: readonly string[]; holderPid: number; cap: number }): Result<number, DbError> {
    return tryMutation("promoteStoreFlightBatch", (conn) => {
        if (params.ids.length === 0) return 0;
        const marks = params.ids.map(() => "?").join(", ");
        return conn
            .query(
                `UPDATE package_store_flights SET updated_at = ?, state = 'running'
                 WHERE id IN (${marks}) AND state = 'queued'
                   AND (SELECT COUNT(DISTINCT holder_pid) FROM package_store_flights WHERE state = 'running' AND holder_pid != ?) < ?`,
            )
            .run(Date.now(), ...params.ids, params.holderPid, params.cap).changes;
    });
}
