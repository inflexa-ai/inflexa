# Fix the model-selection review findings

## Why

The PR #70 review (the `record-model-agent` branch: user-owned model connection + per-agent live
switching) surfaced four defects. Two are load-bearing: (1) a `direct` + `anthropic` connection has
no single `baseURL` that satisfies both the chat path and the model-listing path — the two code
paths assume opposite conventions, so either chat 404s or the picker can never auto-list; (2) the
live sandbox-model switch re-stamps the provenance emitters by mutating fields on the deps objects
the harness's registered workflows closed over, through `as`-casts on `readonly` fields — it works
only because the harness *happens* to re-read those fields per invocation, a contract nothing
states and no test pins. If a harness refactor ever snapshots a field, signed provenance silently
keeps attesting the OLD model while every test stays green. Two are cosmetic: a stale doc comment
describing deleted code, and a misplaced import in a test file.

## What Changes

- **Stable emitter injection (finding 2)** — apply the pattern the chat provider already uses
  (`SwappableChatProvider`: one stable handle injected at boot, inner swapped underneath) to the
  sandbox provenance emitters. Boot constructs ONE stable delegating `artifactRegistry` and ONE
  stable delegating `emitProvenance` function; the harness receives those identities once and
  forever. A live switch swaps the cli-owned *inner* emitters — no harness-owned object is ever
  mutated, so the harness's read discipline (lazy read or registration-time snapshot) becomes
  irrelevant. Deletes the `capturedExecuteAnalysisDeps` capture hack and both `as`-casts in
  `runtime.ts`. A regression test proves swap-safety under the worst case: snapshot the deps field
  first, swap, emit through the snapshot, and the event still carries the new
  `{provider}/{model}`.
- **One baseURL convention for direct-anthropic (finding 1)** — the chat path builds the wire URL
  as `{baseURL}/messages` (the `@ai-sdk/anthropic` convention: the baseURL is the `/v1`-terminated
  API root). The model listing must derive from the SAME value: `{baseURL}/models`, not
  `{baseURL}/v1/models`. Setup's endpoint prompt guidance names the convention so users configure
  one URL that serves both paths.
- **Doc staleness (finding 3)** — `ProvModelId`'s doc comment in `cli/src/types/prov.ts` still
  describes the family-derivation fallback (`unknown/…`, "until provider+model config lands") that
  this branch deleted; rewrite it to state the provider is the configured connection slug.
- **Import placement (finding 4)** — `profile_trigger.test.ts` has two imports stranded below an
  `afterEach` statement; move them up with the sibling imports.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-model-selection`: the live-switch requirement changes HOW application reaches the
  provenance emitters — reconstruction swaps into stable boot-injected delegating handles (never
  mutation of consumer-held deps objects), and correctness must not depend on when the consumer
  reads the deps field. The listing-picker requirement's direct-anthropic listing URL becomes
  `{baseURL}/models` over the same baseURL the chat path uses.
- `model-connection`: the direct-connection requirement gains the baseURL convention — one
  configured value, the `/v1`-terminated protocol root for anthropic, that BOTH the chat wire path
  and the model listing derive from.

## Impact

- `cli/src/modules/harness/runtime.ts` — swap closure replaced by inner-swap on cli-owned holders;
  `capturedExecuteAnalysisDeps` and both `as`-casts deleted.
- `cli/src/modules/harness/run_deps.ts` / `prov_bridge.ts` — the composition carries (or the boot
  injects) the stable delegating emitter handles.
- `cli/src/modules/harness/agent_switch.ts` — `swapSandboxEmitters` wiring unchanged in shape; its
  realization becomes the holder swap.
- `cli/src/modules/harness/model_listing.ts` (+ test) — direct-anthropic URL shape.
- `cli/src/modules/infra/setup.ts` — endpoint-prompt guidance for the anthropic baseURL form.
- `cli/src/types/prov.ts`, `cli/src/modules/harness/profile_trigger.test.ts` — comment/import
  cleanups.
- No `harness/` changes: the deps fields are plain function/interface types; a delegating
  implementation satisfies them as-is.
