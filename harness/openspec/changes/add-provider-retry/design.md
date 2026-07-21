# Design — Add Provider Retry Policy

## Context

`src/providers/ai-sdk.ts` passes `maxRetries: 2` into `generateText`/`streamText`. The installed AI SDK (`ai@7.0.11`) retries only errors carrying `APICallError.isRetryable === true` — which does include connection-level failures (`fetch failed` TypeErrors, Bun network errors are wrapped retryable by `@ai-sdk/provider-utils`) and 429/5xx — but the call surface exposes only the retry *count*. `prepareRetries` hardcodes `initialDelayInMs: 2000` and `backoffFactor: 2` and forwards no cap, so a count of 10 yields delays of 2s…1024s (~68 minutes cumulative). The primitive underneath, `retryWithExponentialBackoff`, is exported from `@ai-sdk/provider-utils` with every knob the wrapper needs: `{maxRetries, initialDelayInMs, backoffFactor, abortSignal, shouldRetry, getDelayInMs, createRetryError}`.

Retry cannot live anywhere else in the stack. The loop wraps `provider.chat` in a plain durable step (`src/loop/run-agent.ts:138`), and provider failures return as `err(ProviderError)` values — a Result crossing `DBOS.runStep` as a return value is durably cached as success (see `src/lib/result.ts` house rules), so DBOS step retries structurally cannot observe a provider failure. The provider seam is the only layer that sees the raw SDK throwable before it becomes a Result.

## Goals / Non-Goals

**Goals:**

- A dead-or-degraded provider gets up to 10 retries with capped exponential backoff before the failure surfaces; worst-case cumulative backoff is minutes, not an hour.
- Retryability is decided by the harness's own taxonomy (`classifyProviderError`), keeping `auth`/`budget`/`tenant-blocked` and other concrete 4xx failures un-retried, per the existing `harness-providers` classification requirement.
- A user abort interrupts a backoff sleep immediately.
- After exhaustion, `toProviderError` still classifies by the real HTTP status of the last failure.

**Non-Goals:**

- Mid-stream recovery: once `chatStream` has yielded a text delta, a broken stream propagates as today — transparent resume would require deduplicating already-yielded text and is a consumer-level concern.
- A host-facing retry configuration surface. Policy ships as named constants in `ai-sdk.ts`; an optional `retry?` field on `AiSdkProviderConfig` is a later extension if a host ever needs different numbers.
- Retrying `EmbeddingProvider.embed` — out of scope for this change; the same wrapper can be lifted there later.

## Decisions

### D1 — Own the retry loop at the provider seam, on the SDK's exported primitive

Wrap the `generateText` call in `retryWithExponentialBackoff` from `@ai-sdk/provider-utils`, with the SDK-internal `maxRetries: 0`. The primitive already handles the mechanics the harness must not get subtly wrong: abort errors re-throw without retry, the backoff sleep takes the `abortSignal` (cancel interrupts the wait), and attempt accounting lives in one place.

- *Alternative — `maxRetries: 10` alone*: rejected; no delay cap exists at the `generateText` surface (tail waits of 8.5/17 minutes).
- *Alternative — DBOS step retries*: rejected; structurally blind to `err()` Results (cached as success).
- *Alternative — custom `fetch` wrapper via the existing `FetchLike` seam*: rejected; reimplements retryability classification from raw responses and interacts badly with streaming bodies.
- *Alternative — `wrapLanguageModel` middleware*: workable location, but separates retry from the error taxonomy already owned by the provider seam.

Inner `maxRetries: 0` is load-bearing: leaving the SDK default (2) multiplies attempts (10 outer × 3 inner = 30 wire calls).

`@ai-sdk/provider-utils` is promoted from transitive to direct dependency in `package.json`, version-aligned with what `ai@7.x` resolves.

### D2 — `shouldRetry` delegates to `classifyProviderError`

The retry predicate is `(e) => classifyProviderError(e).retryable`. This is strictly wider and safer than the SDK's own `APICallError.isRetryable` check: the harness classifier walks `cause` chains for connection codes and guarantees 401/402/403 never retry. It also keeps retryability semantics at their single spec-pinned site (`providers/errors.ts`) instead of introducing a second taxonomy.

### D3 — Policy: 10 retries, 2s initial, ×2 factor, 30s cap, full jitter, honor Retry-After

Named constants in `ai-sdk.ts` (replacing `DEFAULT_MAX_RETRIES`):

- `RETRY_MAX_RETRIES = 10`
- `RETRY_INITIAL_DELAY_MS = 2_000`
- `RETRY_BACKOFF_FACTOR = 2`
- `RETRY_MAX_DELAY_MS = 30_000`

`getDelayInMs` computes `min(exponentialBackoffDelay, RETRY_MAX_DELAY_MS)`, applies full jitter (`Math.random() * capped` bounded below by a small floor is unnecessary — plain full jitter is acceptable; decorrelation matters more than the exact curve), and honors a `Retry-After`/`retry-after-ms` response header when it parses to a sane value `0 ≤ ms ≤ RETRY_MAX_DELAY_MS` (the SDK's own header-respecting variant is not exported, so this mirrors it with the cap folded in). Nominal (un-jittered) delays: 2, 4, 8, 16, 30, 30, 30, 30, 30, 30 — ≈3.5 minutes worst case.

### D4 — Exhaustion rethrows with the last real error on the `cause` chain

`createRetryError` returns an `Error` whose `cause` is the last underlying failure, so `toProviderError` → `extractStatus`'s cause-walk (≤5 hops) classifies the final `ProviderError` by the true HTTP status rather than by a wrapper message.

### D5 — Streaming retries only until the first yielded delta

`chatStream` wraps the *establishment* of the stream: retry the whole `streamText` call while nothing has been yielded to the consumer. The retry closure starts the stream and awaits the first `textStream` pull; the first text delta commits the attempt — from then on errors propagate unchanged. "Provider fails to respond" always fails in the pre-first-delta window, so the stated failure mode is fully covered without ever emitting duplicate text.

Establishment failures reach the closure by two distinct SDK surfacing paths, and both must be handled (verified empirically on `ai@7.x`): a stream that errors before any delta rejects the first pull directly, but a `doStream` *promise rejection* — the shape a real connection failure takes — is deferred by `streamText` past a clean `{done: true}` first pull and only rejects the deferred result promises (`responseMessages`/`finishReason`/`usage`). The closure therefore distinguishes its outcomes: a first pull that yields a delta commits immediately (the deferred promises settle only after full drain, so awaiting them there would deadlock), while a `done` first pull awaits the deferred promises *inside* the envelope — a deferred wire error retries, and a genuine text-less turn resolves them and passes the terminal values out without a second await.

### D6 — Billing headers resolve per attempt

`resolveBilling(session)` moves inside the retried closure so each attempt carries freshly resolved attribution headers. The OSS no-op resolver is unaffected; a managed resolver minting time-limited headers stays valid across a multi-minute retry window.

## Risks / Trade-offs

- [A durable step now blocks up to ~3.5 minutes on a dead provider] → Acceptable: DBOS steps are not checkpointed mid-body, the abort signal still cancels instantly, and the alternative is the step failing on outages the policy exists to ride out.
- [Jitter makes retry timing non-deterministic in tests] → Tests inject deterministic timing by asserting attempt counts and short-circuit behavior against a fake `fetch`, not wall-clock delays; unit tests may pin delays by testing `getDelayInMs` directly.
- [`retryWithExponentialBackoff` is exported but not documented as stable API] → It has been the public export backing `prepareRetries` across AI SDK majors; the surface consumed (`shouldRetry`/`getDelayInMs`/`createRetryError`) is asserted by our own unit tests, so a breaking upstream change fails the build/tests at the pin bump, not at runtime.
- [Retrying a non-idempotent wire call] → Chat completions are idempotent from the caller's perspective (no server-side state is committed by a failed request); a request that *succeeded* but whose response was lost re-bills tokens on retry — accepted, and identical to the SDK's existing behavior.

## Open Questions

None.
