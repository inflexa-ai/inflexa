## Why

`vectorIndexStepOutputs` wraps the entire per-file embed/upsert loop **and** the step summary in a single try/catch that warns and swallows, so the first rejected input (e.g. an over-length document the embedding backend 500s on) abandons every remaining file and the summary for that step. The step still goes green, and the search surface returns fewer hits rather than an error — a customer-observed silent degradation of `workspace_search` (issue #140: 5 occurrences across 3 steps in one run, each single warn hiding an unknown number of lost entries).

## What Changes

- `vectorIndexStepOutputs` isolates each indexed item: every file description and the step summary is embedded and upserted under its own failure boundary, so one rejected input costs exactly its own entry.
- Index setup (`ensureSearchIndex` + store construction) remains all-or-nothing — without an index there is nothing to index into, so setup failure still skips the whole stage.
- Partial failure becomes observable: each failed item logs its id and text length, and a final warn reports how many items indexed vs failed. A partial index is invisible at the search surface, so the logged count is the only signal it happened.
- The stage's contract with the step is unchanged: indexing failures never fail the step.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `artifact-manifest`: the vector-index enrichment stage's degradation granularity changes from per-step (one failure swallows the remaining items) to per-item (one failure costs one entry), and partial failure must be logged with counts.

## Impact

- `harness/src/execution/post-step-pipeline.ts` — `vectorIndexStepOutputs` restructured; no signature change.
- `openspec/specs/artifact-manifest/spec.md` — the "enrichment stages degrade" requirement gains per-item granularity for vector indexing.
- Tests for the new isolation behavior (one poisoned item; setup failure; failure counts).
- Out of scope, deliberately: `synthesize-run.ts` (single document — already isolated), `data-profile.ts` (indexing is integrity-coupled there per `data-profile-init`; changing that is a separate spec decision), and input-length truncation itself (a CLI embedding-provider fix tracked in the cli tree as `token-exact-embedding-truncation`).
- Not affected: vector dimensions, `vector(384/1536)` columns, HNSW indexes.
