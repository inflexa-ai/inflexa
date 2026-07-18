# Tasks: Default Model Election

## 1. Election primitive (proxy/models.ts)

- [x] 1.1 Widen `modelsSchema` to carry optional `created` per model and thread `{ id, created }` through `resolveModelId`
- [x] 1.2 Replace `pickDefaultModel`'s first-match with the deterministic rank: family preference → `created` desc (missing = oldest) → id asc, recency-sorted fallback when no family matches; export the ranked-candidates form for the walk and setup's list
- [x] 1.3 Add the bounded `count_tokens` accessibility check (claude-family on anthropic protocol only) with the three-valued verdict: 200 elect / definite `not_found_error` advance / anything else inconclusive-elect
- [x] 1.4 Wire the election walk into `resolveModelId` — walk ranked candidates, cache the survivor, all-404 yields rank[0] unvalidated; preserve the existing signal/timeout discipline and `proxy_unreachable` bridging
- [x] 1.5 Unit tests: rank determinism under shuffled serving order, recency-over-position, missing-`created` tiebreak, walk-past-404, inconclusive-accept on timeout/5xx, all-404 top-candidate fallback, cache shares one election across callers (use `__resetModelCacheForTest`; inject fetch via seams per the existing test pattern)

## 2. Launch probe (infra/setup.ts)

- [x] 2.1 Confirm `probeOnce` inherits the election through `resolveModelId` unchanged; adjust `classifyModelResolution` only if the election introduces a new `ChatSetupError` shape (design intends none)
- [x] 2.2 Add the stale-pin check to the launch gate: for each distinct pinned model (`models.agents.*`, `harness.model`) on an anthropic-family cliproxy connection, run the bounded `count_tokens` check; definite 404 → warn naming model, agent(s), and repick remedy; inconclusive → silent; never block, never rewrite config
- [x] 2.3 Unit tests: probe passes with an inaccessible top candidate (elected past it), stale-pin warn on 404, silence on 200 and on timeout, non-anthropic and auto-resolved sessions skip the pin check

## 3. Setup model-selection step (infra/setup.ts)

- [x] 3.1 Build the accessibility-swept model list for the select prompt: connection-family ids from `/models`, bounded-concurrency `count_tokens` sweep, exclude only definite 404s, keep inconclusive entries
- [x] 3.2 Add the interactive select after login+probe: preselected `Auto — recommended: <elected>` row plus the swept list; Auto → write nothing; explicit pick → `writeAgentModel` for both agents; non-TTY skips the step; no hardcoded model ids
- [x] 3.3 Unit tests: Auto writes nothing, explicit pick writes both agent keys, 404-swept model absent from the list, timed-out model present, non-TTY skip

## 4. Picker commit-time validation (TUI)

- [x] 4.1 Expose a single commit-validation helper for the picker (anthropic protocol → bounded `count_tokens`; `openai-compatible` → commit as today), shared with the setup sweep rather than reimplemented
- [x] 4.2 Wire validation into the model-switch commit path (listed and free-text): busy state while checking, definite 404 keeps the dialog open with an inline error naming the model and the account-accessibility cause, 200/inconclusive persists via `writeAgentModel` as today
- [x] 4.3 Tests: 404 rejects in-dialog without a config write, timeout commits, openai-compatible skips validation (follow the existing picker/dialog test patterns)

## 5. Verification and docs

- [x] 5.1 `bun run typecheck && bun run lint && bun test`, plus `bun run format:file` on every touched `src/` file
- [x] 5.2 Live verification against the local proxy: repeated launches elect the same model, no `Provider login not verifiable (HTTP 404)` on a healthy credential, setup shows the swept list with Auto preselected, picker rejects a known-inaccessible id in-dialog
- [x] 5.3 Update `CONTEXT.md`/module docs where they describe the default-model pick, and note the election in the `proxy/models.ts` header comment
