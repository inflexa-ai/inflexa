/**
 * Refresh the FDA/ICH regulatory corpus stored in `cortex_regulatory_chunks`.
 *
 * Pipeline: list documents → download → extract text → chunk → embed →
 * upsert into `cortex_regulatory_chunks`. Idempotent at the (source, doc_id)
 * grain — re-running replaces existing rows.
 *
 * Two callers:
 *   - `scripts/index-regulatory-corpus.ts` — operator-run CLI
 *   - `regulatory-corpus-boot-refresh.ts` — automatic 90-day-stale boot trigger
 */

import type { Pool } from "pg";

import { unwrapOrThrow } from "../lib/result.js";
import { fetchFdaGuidanceListing, fetchAndExtractFdaDoc, type FdaCenter, type FdaDocStub } from "../lib/regulatory-corpus/fetch-fda-guidance.js";
import { fetchIchListing, fetchAndExtractIchDoc, type IchStub } from "../lib/regulatory-corpus/fetch-ich.js";
import { chunkText, upsertChunks, type ChunkRow } from "../lib/regulatory-corpus.js";

export type RegulatoryCorpusSource = "FDA-CDER" | "FDA-CBER" | "ICH";
export const REGULATORY_CORPUS_SOURCES: RegulatoryCorpusSource[] = ["FDA-CDER", "FDA-CBER", "ICH"];

// A large guidance doc can chunk into 200-500+ pieces. Firing them all at
// once trips embedding-API rate limits and silently truncates the upserted
// chunks, so we batch.
const EMBED_CONCURRENCY = 20;

export interface RefreshResult {
    ok: number;
    fail: number;
}

export interface RefreshOptions {
    pool: Pool;
    sources?: RegulatoryCorpusSource[];
    /**
     * Embedder used to vectorise chunks. Required — callers must build one
     * via `buildMaintenanceEmbedder(env)` (direct OpenAI, bypassing the billing gateway)
     * or supply an injected stub for tests. There is no default: the corpus
     * refresh is system-scoped maintenance work with no analysis to bill
     * against, so we never silently fall through to the billing-gateway-routed
     * `createEmbedder()` and emit unattributed calls.
     */
    embedder: (text: string) => Promise<number[]>;
    /** Logger used for per-doc progress. Defaults to `console`. */
    log?: Pick<Console, "log" | "error">;
}

/**
 * Build an embedder that talks directly to api.openai.com using the given
 * `apiKey`, bypassing the billing gateway.
 *
 * Returns `null` when `apiKey` is missing — callers MUST treat that as
 * "auto-refresh disabled" rather than falling back to the workspace
 * embedder (`workspace/search-config.ts`), which routes through the billing gateway
 * via `OPENAI_BASE_URL` and would generate unbilled calls outside an ALS
 * billing scope.
 *
 * The model id mirrors the workspace embedder default
 * (`text-embedding-3-small`, 1536 dim) so chunks remain comparable to the
 * default `cortex_regulatory_chunks.embedding` shape. Pass the existing
 * `OPENAI_API_KEY` (a real OpenAI key, NOT a billing-gateway virtual key — direct
 * calls to api.openai.com would 401 against a `sk-billing-*` value).
 */
export function buildMaintenanceEmbedder(opts: { apiKey?: string; embeddingModel?: string }): ((text: string) => Promise<number[]>) | null {
    const { apiKey } = opts;
    if (!apiKey) return null;

    // Strip the `openai/` provider prefix if present; we always talk to OpenAI here.
    const id = opts.embeddingModel ?? "openai/text-embedding-3-small";
    const modelId = id.startsWith("openai/") ? id.slice("openai/".length) : id;

    // Direct call to api.openai.com (bypasses the billing gateway) — unbilled maintenance
    // path. See doc comment above.
    return async (text: string) => {
        const res = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: modelId, input: text, encoding_format: "float" }),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`buildMaintenanceEmbedder: openai /embeddings ${res.status}: ${body}`);
        }
        const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
        const embedding = data.data?.[0]?.embedding;
        if (!embedding) throw new Error("buildMaintenanceEmbedder: empty response");
        return embedding;
    };
}

async function listForSource(source: RegulatoryCorpusSource): Promise<Array<FdaDocStub | IchStub>> {
    switch (source) {
        case "FDA-CDER":
            return (await fetchFdaGuidanceListing("CDER")).map((s) => ({
                ...s,
                center: "CDER" as FdaCenter,
            }));
        case "FDA-CBER":
            return (await fetchFdaGuidanceListing("CBER")).map((s) => ({
                ...s,
                center: "CBER" as FdaCenter,
            }));
        case "ICH":
            return await fetchIchListing();
    }
}

async function fetchOne(source: RegulatoryCorpusSource, stub: FdaDocStub | IchStub) {
    if (source === "ICH") return await fetchAndExtractIchDoc(stub as IchStub);
    return await fetchAndExtractFdaDoc(stub as FdaDocStub);
}

async function indexSource(
    pool: Pool,
    source: RegulatoryCorpusSource,
    embedder: (t: string) => Promise<number[]>,
    log: Pick<Console, "log" | "error">,
): Promise<RefreshResult> {
    log.log(`\n=== ${source} ===`);
    const stubs = await listForSource(source);
    log.log(`  ${stubs.length} document(s) listed`);

    let ok = 0;
    let fail = 0;

    for (const stub of stubs) {
        try {
            const doc = await fetchOne(source, stub);
            const rawChunks = chunkText(doc.text);
            if (rawChunks.length === 0) {
                log.error(`  SKIP ${doc.doc_id}: no chunks emitted`);
                continue;
            }
            const embeddings: number[][] = [];
            for (let i = 0; i < rawChunks.length; i += EMBED_CONCURRENCY) {
                const batch = rawChunks.slice(i, i + EMBED_CONCURRENCY);
                const batchResults = await Promise.all(batch.map((c) => embedder(c.text)));
                embeddings.push(...batchResults);
            }
            const chunks = rawChunks.map((c, i) => ({ ...c, embedding: embeddings[i]! }));
            const row: ChunkRow = {
                source,
                doc_id: doc.doc_id,
                doc_title: doc.doc_title,
                doc_url: doc.doc_url,
                chunks,
                metadata: doc.metadata as Record<string, unknown>,
            };
            unwrapOrThrow(await upsertChunks(pool, row));
            ok++;
            log.log(`  ok ${doc.doc_id} (${chunks.length} chunks)`);
        } catch (err) {
            fail++;
            const msg = err instanceof Error ? err.message : String(err);
            log.error(`  FAIL ${stub.doc_id}: ${msg}`);
        }
    }

    return { ok, fail };
}

/**
 * Refresh one or more regulatory corpus sources end-to-end. Returns
 * aggregate ok/fail counts across all requested sources. Never throws —
 * per-document failures are counted but do not abort the run.
 */
export async function refreshRegulatoryCorpus(opts: RefreshOptions): Promise<RefreshResult> {
    const sources = opts.sources ?? REGULATORY_CORPUS_SOURCES;
    const { pool, embedder } = opts;
    const log = opts.log ?? console;

    let totalOk = 0;
    let totalFail = 0;
    for (const source of sources) {
        const { ok, fail } = await indexSource(pool, source, embedder, log);
        totalOk += ok;
        totalFail += fail;
    }

    log.log(`\nDone. ok=${totalOk} fail=${totalFail}`);
    return { ok: totalOk, fail: totalFail };
}
