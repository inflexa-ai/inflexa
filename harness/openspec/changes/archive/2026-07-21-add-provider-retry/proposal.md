# Add Provider Retry Policy

## Why

A provider that fails to respond (connection refused, reset, DNS failure, 429/5xx) currently exhausts the AI SDK's hardcoded 2 retries in ~6 seconds and surfaces a failure to the loop — a brief provider outage or local-proxy restart breaks an agent turn or a durable workflow step immediately. The AI SDK exposes only a retry *count* (`maxRetries`); its 2s initial delay and ×2 factor are hardcoded with no delay cap, so raising the count alone produces unbounded tail waits (a 10th retry would wait ~17 minutes). The harness must own a bounded retry policy at the provider seam, because no other layer can: provider failures return as `err()` Results, which a DBOS step caches as *success* — durable-step retries never see them.

## What Changes

- The AI SDK provider (`src/providers/ai-sdk.ts`) wraps `generateText` in a harness-owned retry loop built on `retryWithExponentialBackoff` from `@ai-sdk/provider-utils`, with the SDK's inner `maxRetries` set to `0` so attempts do not multiply.
- Retry policy: 10 retries, 2s initial delay, ×2 backoff factor, per-delay cap of 30s, full jitter, honoring `Retry-After`/`retry-after-ms` response headers when sane and within the cap (worst-case cumulative backoff ≈ 3.5 minutes).
- Retryability is decided by the harness's own `classifyProviderError` — transient failures (429/5xx/connection) retry; `auth`/`budget`/`tenant-blocked` (401/402/403) and other concrete 4xx never retry. Aborts propagate immediately, including out of a backoff sleep.
- On exhaustion, the final thrown error carries the last underlying provider error on its `cause` chain so `toProviderError` classification still keys on the real HTTP status.
- `chatStream` retries the `streamText` call only until the first text delta has been yielded; after that, mid-stream failures propagate unchanged.
- Billing headers are re-resolved via `ResolveBilling` per attempt, so time-limited attribution headers stay fresh across a multi-minute retry window.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the provider SHALL retry transient failures under a bounded exponential-backoff policy before surfacing a `ProviderError`; today the spec defines retryability classification only, with no requirement that the provider itself retries.

## Impact

- `harness/src/providers/ai-sdk.ts` — retry wrapper around `generateText`/`streamText`; new policy constants.
- `harness/src/providers/errors.ts` — unchanged; `classifyProviderError` is reused as the retry predicate.
- No public API change: `ChatProvider` signatures, `AiSdkProviderConfig`, and the CLI's wiring are untouched — policy ships as harness constants.
- Dependency surface: imports `retryWithExponentialBackoff` from `@ai-sdk/provider-utils` (already an installed transitive dependency of `ai`; must be promoted to a direct dependency in `package.json`).
- Tests: unit tests driving the provider against a failing fake `fetch` (retry-then-succeed, non-retryable short-circuit, abort during backoff, stream first-delta cutoff).
