## Context

The local provider wraps the harness's OpenAI-shaped client pointed at a loopback `llama-server` sidecar (`baseURL = ${origin}/v1`). Every input is guarded by `guardInputLength` — a pure 1600-character cap applied in `embed()` *before* the sidecar is even launched. The cap is probabilistic: it assumes a chars-per-token density, and real content (dense scientific prose ≈ 2.69 chars/token, CJK ≈ 2.76) crosses the model's hard 512-position ceiling well under 1600 chars, drawing an HTTP 500 per over-length input. `bge-small` cannot accept more than 512 positions regardless of server flags, so client-side bounding is mandatory; the only question is how the bound is computed.

The pinned server build (`b9310`) serves `POST /tokenize` — the exact tokenizer of the loaded model, in the same process that will serve the embed. Measured ground truth: a 1589-char guarded input tokenizes to 590 content tokens, and the server rejects it as 592 — the `[CLS]`/`[SEP]` pair costs 2, so the real content budget is 510.

## Goals / Non-Goals

**Goals:**

- An input the guard passes can **never** be rejected as over-length — exact, not probabilistic.
- Keep as much of each document as the ceiling allows: these are retrieval documents; a worst-case-density char cap would discard most of a typical document that token-exact truncation keeps.
- Zero cost for the common case (short file descriptions) and bounded, small cost for over-length documents.
- Measurement failure degrades the input bound, never the embed.

**Non-Goals:**

- Guarding the api-key path. Its endpoint/model set is open (user-configured), no tokenize endpoint exists in the OpenAI-compatible contract, and its ~8k ceiling makes precision nearly worthless (any generous char cap keeps real documents whole). Its rejections are contained per-item by the harness change `isolate-vector-index-failures`. A generic optional `maxInputChars` on the harness client is a possible follow-up, not this change.
- Chunk-then-mean-pool. Truncation (keep the head) is retained: the salient topic of these documents sits up front, and mean-pooled chunk vectors would be qualitatively unlike the api-key path's single-vector embeds.
- Caching token counts across calls. Inputs are embedded once on their write path; a cache buys nothing.

## Decisions

**Token-exact via `/tokenize`, not a lower char cap, not a bundled tokenizer.** The only *provable* char cap is 510 chars (worst-case one token per char) — it discards ~⅔ of a typical document; any higher cap is the same probabilistic bet that caused the bug. Bundling a tokenizer (WordPiece vocab or tiktoken-style) adds a dependency and a drift risk against the model actually loaded; `/tokenize` is the loaded model's own tokenizer, free, and pinned with the server build.

**Budget 510 content tokens.** 512 minus the `[CLS]`/`[SEP]` wrap, matching the measured 590→592 discrepancy. `/tokenize` is called without special tokens, measuring content only; the budget already reserves the pair.

**Fast path on UTF-16 length.** `text.length <= 510` returns unchanged with no round-trip. Sound because a WordPiece token consumes at least one codepoint and a codepoint is at least one UTF-16 code unit, so token count ≤ `length`. This covers the dominant input class (one-sentence descriptions).

**Measure once, cut proportionally to the *measured* density, re-measure; bounded rounds.** For a text measuring `n > 510` tokens, cut at `510 × (length/n) × 0.95` with the existing word-boundary backoff, then re-measure the candidate. Density is near-uniform within a document, so the first proportional cut typically lands; one more overshoot-scaled shrink round follows, then the fallback. Re-measuring every candidate (rather than trusting the 0.95 margin) is the point — density varies within a document (prose lede, then a dense table), and the guarantee must be exact. Alternatives rejected:
- *Binary search on cut position*: log₂(n) round-trips for the same answer proportional cutting reaches in 1–2.
- *Reconstruct the prefix from `with_pieces`*: pieces are the tokenizer's normalized surface (lowercased, `##` continuations), so a joined prefix embeds mutated text and couples the code to WordPiece internals. Measure-and-cut keeps the tokenizer a black box that only ever answers "how many".

**Deterministic fallback: hard cut at 510 code units.** The landing zone both for exhausted rounds and for any `/tokenize` failure (error, timeout, non-JSON body). Provably fits with no tokenizer, so the embed proceeds on every path — degraded input bound, never a failed embed. All tokenize interaction returns `Result` per the CLI's neverthrow discipline; a tokenize `err` selects the fallback rather than propagating.

**Guard moves after `ensureReady`; the ready handle carries the origin.** Today the guard is pure and runs before launch; token measurement needs the live sidecar, so `embed()` becomes `ensureReady → fit each text → provider.embed`. `/tokenize` lives at the server root while the handle exposes only `${origin}/v1`, so the launch site (which has the origin in scope) puts it on the handle rather than any caller string-parsing it back out. The tokenize request sends the minted key — whether the pinned build gates `/tokenize` behind the key is verified at implementation, but sending it is correct in both cases. Each tokenize request carries its own bounded timeout so a wedged server degrades to the fallback instead of hanging the embed path.

## Risks / Trade-offs

- [Over-length documents now cost 1–3 loopback round-trips before embedding] → each is a few ms against a local server, only over-length inputs pay it, and the alternative (worst-case char cap) pays in permanently lost document tail instead.
- [`/tokenize` response shape drifts on a future server upgrade] → the runtime is hash-pinned (`llama_runtime.ts`); an upgrade is a deliberate act that re-verifies the endpoint, and any response-shape surprise lands in the fallback path, not a failure.
- [The 0.95 margin under-uses the budget slightly when the first cut fits] → a few tokens of headroom traded for converging in one round on nearly all documents.
- [Word-boundary backoff can shorten a fallback cut below 510 units] → acceptable; the backoff only trims a dangling partial word, and correctness (≤510 tokens) is unaffected.

## Migration Plan

None: no signature, schema, or dimension change. Previously truncated-at-1600 documents re-embed with more (or all) of their content the next time their write path runs; existing index entries are untouched until then.

## Open Questions

- Whether the pinned build gates `/tokenize` behind the API key — resolved by a one-off check at implementation time; the request sends the key either way.
