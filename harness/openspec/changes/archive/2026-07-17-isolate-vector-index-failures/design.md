## Context

`vectorIndexStepOutputs` (`src/execution/post-step-pipeline.ts`) is the vector-index enrichment stage of the post-step pipeline. It embeds and upserts each surviving file description plus the step summary into the per-analysis pgvector index. Today one try/catch spans index setup, the whole per-file loop, and the summary: any single embed/upsert failure warns once and abandons everything after it. The `artifact-manifest` spec makes the stage best-effort (indexing must never fail the step), which the fix preserves — only the granularity of degradation changes.

The dominant real-world failure is a deterministic per-input rejection: a local embedding backend with a hard context ceiling answers one over-length document with an HTTP 500 on that input's own merits. Preventing those rejections is a CLI embedding-provider concern (cli change `token-exact-embedding-truncation`); this change makes the harness robust to whatever rejections still occur, from any `EmbeddingProvider` realization.

## Goals / Non-Goals

**Goals:**

- One rejected input costs exactly its own index entry — every other file and the summary still land.
- Partial failure is observable in the logs: which item failed, and how many landed vs were lost.
- The stage's contract is untouched: indexing failures never fail the step.

**Non-Goals:**

- Input truncation/chunking (provider-side; tracked in the cli tree).
- Changing `synthesize-run.ts` (single document — its existing isolated try/catch already has per-item granularity) or `data-profile.ts` (indexing there is integrity-coupled by `data-profile-init`; loosening that is a separate spec decision).
- Retrying failed items: the dominant rejection is deterministic for a given input, so a retry spends latency to reproduce the same failure.
- Surfacing indexing degradation beyond logs (run events, UI). The logged counts are the minimum observability; a richer surface is future work.

## Decisions

**Index setup stays all-or-nothing.** `ensureSearchIndex` + store construction happen before the loop under their own catch; if the index cannot exist there is no meaningful per-item work, so setup failure degrades the whole stage exactly as today.

**Per-item boundary is a local `indexOne(id, text, metadata) → boolean` helper.** Each call embeds and upserts one item, absorbing its own failure and logging it with the item `id` and `textLength`. `textLength` is logged because over-length input is the known failure driver — it lets a reader separate the oversized-document case from transient faults without logging the content itself (descriptions and summaries describe user data and stay out of logs). Alternative considered: collecting error objects and logging once at the end — rejected because the per-item log line carries per-item context (id, length) that an aggregate cannot, and the aggregate count is still emitted separately.

**Counts, then a single summary warn.** The stage tallies `indexed`/`failed` and, when `failed > 0`, emits one `"indexed with failures"` warn with both counts. A partial index is invisible at the search surface — it returns fewer hits, never an error — so the counts are the only signal degradation happened at all.

**Log level stays `warn`.** The spec defines the stage as best-effort degradation; `error` would misrepresent a tolerated condition. The logger keeps the existing `post-step.vector-index` namespace with `runId`/`stepId` as structured fields (bound once via `.with(...)`).

**Loop stays sequential.** Isolation changes the failure boundary, not the concurrency model; parallelizing embeds is an unrelated performance decision.

## Risks / Trade-offs

- [A systematically failing backend now emits one warn per item instead of one per step] → bounded by the step's file count, and the summary-count warn gives the one-line view; noisy logs under total failure are preferable to a silent empty index.
- [Per-item catch could mask a wedged backend as N independent failures] → the failure count in the summary warn makes "everything failed" visually distinct from "one item failed"; liveness of the provider is out of this stage's scope.

## Migration Plan

None required: internal function, no signature change, no schema change. Under partial failure, strictly more entries land in the index than before.

## Open Questions

None.
