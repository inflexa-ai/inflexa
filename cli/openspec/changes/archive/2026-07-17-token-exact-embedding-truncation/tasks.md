## 1. Plumbing: expose what the guard needs

- [x] 1.1 Carry the server `origin` on the ready sidecar handle (the launch site building `${origin}/v1` has it in scope); update the test launcher stubs that construct handles
- [x] 1.2 Add the in-file tokenize client: `POST {origin}/tokenize` with the minted key and a bounded per-request timeout, returning `Result<number, _>` (content token count, no special tokens); bridge fetch/JSON throws into `Result` at the boundary

## 2. Token-exact guard

- [x] 2.1 Replace `guardInputLength` with the budgeted fit: 510-code-unit fast path (no round-trip) → measure whole, pass when ≤510 → proportional cut at `510 × measured density × 0.95` with the existing word-boundary backoff → re-measure, one overshoot-scaled retry → hard cut at 510 code units on exhaustion or any tokenize failure
- [x] 2.2 Move the guard in `embed()` from before `ensureReady` to after it (fit each text against the ready sidecar, then call the wrapped provider); discharge the `TODO(robustness)` comment and rewrite the `MAX_INPUT_CHARS` block comment to document the token-exact rationale and the 510 budget
- [x] 2.3 Verify against the pinned `b9310` server whether `/tokenize` is key-gated (send the key regardless); note the answer in the tokenize client's comment

## 3. Tests (stub-sidecar rig)

- [x] 3.1 Fast path: a ≤510-code-unit input embeds with zero `/tokenize` requests recorded by the stub
- [x] 3.2 Recovery: a >510-char input the stub tokenizer measures ≤510 tokens embeds unchanged
- [x] 3.3 Convergence: an over-budget input (stub tokenizer with non-uniform density) embeds as a word-boundary prefix whose measured count is ≤510, and the embeddings endpoint never sees an over-length input
- [x] 3.4 Fallback: `/tokenize` failing (error and timeout) embeds the 510-code-unit hard cut and the embed still succeeds

## 4. Verify

- [x] 4.1 `bun run typecheck`, `bun run lint`, `bun test`; `bun run format:file` on touched `src/` files
- [x] 4.2 `openspec validate token-exact-embedding-truncation`
