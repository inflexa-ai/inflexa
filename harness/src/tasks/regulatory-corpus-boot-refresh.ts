/**
 * Boot-time regulatory corpus refresher.
 *
 * On every Cortex startup, check whether `cortex_regulatory_chunks` was
 * last refreshed more than 90 days ago (or has never been populated). If
 * stale, fire `refreshRegulatoryCorpus()` asynchronously so it does not
 * block the server from coming up.
 *
 * Multi-replica safety: the refresh acquires a Postgres advisory lock on
 * a dedicated `pg.Client` (advisory locks are session-scoped, so the lock
 * only releases when the client connection closes — which we do explicitly
 * after the refresh resolves or rejects). Replicas that lose the race
 * skip silently. The 90-day check itself is racy against the lock holder
 * but the cost of a redundant check is one round-trip; the actual scrape
 * is what we serialize.
 */

import type { Pool, PoolClient } from "pg";
import { buildMaintenanceEmbedder, refreshRegulatoryCorpus, type RefreshOptions } from "./refresh-regulatory-corpus.js";

export const REFRESH_INTERVAL_DAYS = 90;
const ADVISORY_LOCK_KEY = "cortex_regulatory_corpus_refresh";

export interface BootRefreshDeps {
    /** Shared `pg.Pool`. */
    pool: Pool;
    /** Forwarded to `refreshRegulatoryCorpus()` when the refresh fires. */
    refreshOptions?: Omit<RefreshOptions, "embedder">;
    /**
     * Embedder injected directly (used by tests). When omitted, the boot
     * task derives one from `REGULATORY_CORPUS_OPENAI_API_KEY` — and skips
     * the refresh when that env var is unset, to avoid generating
     * unattributed billing-gateway calls outside any billing scope.
     */
    embedder?: (text: string) => Promise<number[]>;
    /** Override the refresh function (used by tests). */
    refresh?: typeof refreshRegulatoryCorpus;
    /** Logger. Defaults to `console`. */
    log?: Pick<Console, "log" | "warn" | "error">;
    /** Override the staleness threshold (used by tests). */
    intervalDays?: number;
    /** Embedding model for the maintenance embedder (when `embedder` omitted). */
    embeddingModel?: string;
    /** Direct OpenAI key for the maintenance embedder (NOT a billing-gateway VK). */
    openaiApiKey?: string;
}

interface FreshnessRow {
    last_indexed_at: Date | null;
    age_days: number | null;
}

async function checkFreshness(pool: Pool, intervalDays: number): Promise<{ stale: boolean; lastIndexedAt: Date | null; ageDays: number | null }> {
    const { rows } = await pool.query<FreshnessRow>(
        `SELECT MAX(indexed_at) AS last_indexed_at,
            EXTRACT(EPOCH FROM (NOW() - MAX(indexed_at))) / 86400 AS age_days
     FROM cortex_regulatory_chunks`,
    );
    const row = rows[0];
    const lastIndexedAt = row?.last_indexed_at ?? null;
    const ageDays = row?.age_days != null ? Number(row.age_days) : null;
    const stale = lastIndexedAt === null || (ageDays ?? Infinity) >= intervalDays;
    return { stale, lastIndexedAt, ageDays };
}

/**
 * Hash a string into a bigint suitable for `pg_try_advisory_lock(bigint)`.
 * Uses Postgres's own `hashtext()`.
 */
async function tryAcquireLock(client: PoolClient): Promise<boolean> {
    const { rows } = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired", [ADVISORY_LOCK_KEY]);
    return rows[0]?.acquired === true;
}

async function releaseLock(client: PoolClient): Promise<void> {
    try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
    } catch {
        // Connection may already be closed/poisoned — release-on-disconnect
        // covers us. Swallow.
    }
}

/**
 * Check the corpus freshness and, if stale, kick off an asynchronous
 * refresh. Resolves quickly — does NOT wait for the refresh to finish.
 *
 * Returns:
 *   - "skipped-fresh" when corpus age < intervalDays
 *   - "skipped-unconfigured" when no maintenance embedder is available
 *     (no `REGULATORY_CORPUS_OPENAI_API_KEY` and no injected embedder)
 *   - "skipped-locked" when another replica holds the advisory lock
 *   - "started" when this replica acquired the lock and dispatched the refresh
 *   - "error" when the freshness check itself failed (refresh not attempted)
 */
export async function maybeKickOffRegulatoryCorpusRefresh(
    deps: BootRefreshDeps,
): Promise<"skipped-fresh" | "skipped-unconfigured" | "skipped-locked" | "started" | "error"> {
    const pool = deps.pool;
    const log = deps.log ?? console;
    const intervalDays = deps.intervalDays ?? REFRESH_INTERVAL_DAYS;
    const refresh = deps.refresh ?? refreshRegulatoryCorpus;

    // Freshness first — cheap (single query) and has no env dependency. Pod
    // restarts and scale-ups on a long-lived cluster hit this path constantly;
    // logging "auto-refresh disabled because key is unset" on every one of
    // them creates alert fatigue. Only complain about missing config when a
    // refresh is actually needed.
    let freshness: Awaited<ReturnType<typeof checkFreshness>>;
    try {
        freshness = await checkFreshness(pool, intervalDays);
    } catch (err) {
        log.warn("[boot] Regulatory corpus freshness check failed; skipping auto-refresh:", err instanceof Error ? err.message : err);
        return "error";
    }

    if (!freshness.stale) {
        log.log(`[boot] Regulatory corpus is fresh (age ${freshness.ageDays?.toFixed(1)}d < ${intervalDays}d); skipping refresh`);
        return "skipped-fresh";
    }

    // Corpus is stale — resolve the maintenance embedder. System-scoped
    // maintenance work has no analysis/target-assessment to bill against, so
    // we route directly to api.openai.com on a dedicated key. Never the
    // billing-gateway-routed workspace embedder, which would emit unattributed calls
    // and flood the boot log via `billing-fetch-patch`.
    let embedder: ((text: string) => Promise<number[]>) | null = deps.embedder ?? null;
    if (!embedder) {
        try {
            embedder = buildMaintenanceEmbedder({
                apiKey: deps.openaiApiKey,
                embeddingModel: deps.embeddingModel ?? "",
            });
        } catch (err) {
            log.warn("[boot] Could not load env for regulatory corpus refresh; skipping:", err instanceof Error ? err.message : err);
            return "skipped-unconfigured";
        }
    }
    if (!embedder) {
        const ageStr = freshness.lastIndexedAt === null ? "empty" : `age ${freshness.ageDays?.toFixed(1)}d`;
        log.warn(
            `[boot] Regulatory corpus is stale (${ageStr}) but ` +
                "REGULATORY_CORPUS_OPENAI_API_KEY is unset; skipping auto-refresh. " +
                "Set it (a real OpenAI key, NOT a billing-gateway virtual key — the " +
                "maintenance embedder talks direct to api.openai.com) to enable, " +
                "or run scripts/index-regulatory-corpus.ts manually.",
        );
        return "skipped-unconfigured";
    }

    // Acquire the advisory lock on a dedicated pool client. We hold this
    // client (and the lock) for the whole refresh — releasing it only after
    // the detached promise settles. Other replicas booting in the meantime
    // hit `pg_try_advisory_lock` and skip.
    const client = await pool.connect();
    let acquired: boolean;
    try {
        acquired = await tryAcquireLock(client);
    } catch (err) {
        client.release();
        log.warn("[boot] Regulatory corpus advisory-lock attempt failed; skipping auto-refresh:", err instanceof Error ? err.message : err);
        return "error";
    }

    if (!acquired) {
        client.release();
        log.log("[boot] Regulatory corpus refresh already in progress on another replica; skipping");
        return "skipped-locked";
    }

    const ageStr = freshness.lastIndexedAt === null ? "empty" : `age ${freshness.ageDays?.toFixed(1)}d`;
    log.log(`[boot] Regulatory corpus is stale (${ageStr}); starting async refresh in background`);

    // Detached promise — startup must not wait for this to finish.
    const dispatchEmbedder = embedder;
    void (async () => {
        try {
            const result = await refresh({
                ...(deps.refreshOptions ?? {}),
                pool,
                embedder: dispatchEmbedder,
            });
            log.log(`[boot] Regulatory corpus refresh complete: ok=${result.ok} fail=${result.fail}`);
        } catch (err) {
            log.error("[boot] Regulatory corpus refresh threw:", err instanceof Error ? err.message : err);
        } finally {
            await releaseLock(client);
            client.release();
        }
    })();

    return "started";
}
