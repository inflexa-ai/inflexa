## Why

The local embedding provider guards the bge-small 512-token per-input ceiling with a 1600-character cap whose own arithmetic exceeds the ceiling (1600 ÷ its assumed 3.1 chars/token = 516 tokens), and real content tokenizes denser still (measured 2.69 chars/token for gene-name/statistics-heavy prose → ~594 tokens). Guarded inputs draw HTTP 500s from `llama-server`, violating the `local-embeddings` spec requirement that an over-length input never surface as a raw server error — and silently degrading `workspace_search`, since the harness swallows indexing failures (issue #140, observed on a customer machine).

## What Changes

- `guardInputLength`'s probabilistic character cap is replaced by token-exact truncation: token counts are measured with the sidecar's own `/tokenize` endpoint — the same process and tokenizer that serves the embed, available on the pinned server build with no new dependency.
- The budget is 510 content tokens (512 minus the `[CLS]`/`[SEP]` pair the tokenizer wraps around content), and the guarantee is exact: an input the guard passes can never be rejected as over-length.
- Inputs of ≤510 UTF-16 code units skip measurement entirely (a WordPiece token consumes at least one code unit, so token count cannot exceed length) — the typical one-sentence file description costs no round-trip.
- Long inputs that actually fit are embedded whole: documents in the ~1600–2000-character range that the current cap blindly cuts are recovered when they measure ≤510 tokens.
- Over-length inputs are cut proportionally to their measured chars-per-token density (word-boundary backoff retained, head kept) and re-measured until they fit, within a bounded number of rounds; exhaustion or any `/tokenize` failure degrades to a provably-fitting 510-code-unit hard cut — measurement can never fail an embed.
- The guard moves from before sidecar launch to after readiness (it needs the live sidecar), and the ready handle carries the server origin (`/tokenize` lives at the root, not under `/v1`).

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `local-embeddings`: the input-length guard requirement changes from "truncate or chunk client-side" (mechanism unspecified, currently realized as a character cap that does not actually guarantee the ceiling) to token-exact truncation with a hard guarantee, a measurement-free fast path, and a provable fallback. The guard concern moves out of the sidecar-lifecycle requirement into its own requirement.

## Impact

- `cli/src/modules/embedding/local-provider.ts` — `guardInputLength` replaced, guard relocated after `ensureReady`, ready-handle type gains the origin, tokenize client added (single caller, stays in-file). The `TODO(robustness)` naming token-aware truncation as the real fix is discharged.
- `openspec/specs/local-embeddings/spec.md` — delta as above.
- Tests on the existing stub-sidecar rig (fast path, fitting-long-input, truncation convergence, fallback on tokenize failure).
- No new dependencies. Vector width (384) and existing indexes untouched — truncation changes input length, not output dimensions.
- The api-key path deliberately keeps no guard here: its endpoint/model set is open (user-configured `baseURL`/`model`), no tokenizer is available in its contract, and its practical ceiling is ~16× higher; rejections there are contained per-item by the harness change `isolate-vector-index-failures`.
