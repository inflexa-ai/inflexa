# Tasks — Add Provider Retry Policy

## 1. Dependencies

- [x] 1.1 Promote `@ai-sdk/provider-utils` to a direct dependency in `harness/package.json`, version-aligned with what `ai@7.x` resolves, and reinstall so the lockfile records it

## 2. Retry policy in the provider seam

- [x] 2.1 In `src/providers/ai-sdk.ts`, replace `DEFAULT_MAX_RETRIES` with the policy constants (`RETRY_MAX_RETRIES = 10`, `RETRY_INITIAL_DELAY_MS = 2_000`, `RETRY_BACKOFF_FACTOR = 2`, `RETRY_MAX_DELAY_MS = 30_000`) and build the shared retry wrapper on `retryWithExponentialBackoff` from `@ai-sdk/provider-utils`: `shouldRetry` delegates to `classifyProviderError(e).retryable`; `getDelayInMs` applies the 30s cap with full jitter and honors `Retry-After`/`retry-after-ms` when it parses to `0 ≤ ms ≤ cap`; `createRetryError` returns an `Error` whose `cause` is the last underlying failure
- [x] 2.2 Wire `chat` through the wrapper: move `resolveBilling(session)` inside the retried closure, pass `maxRetries: 0` to `generateText`, and thread the caller's `AbortSignal` into the wrapper so an abort interrupts the backoff sleep
- [x] 2.3 Wire `chatStream` through the wrapper for stream establishment only: the retried closure starts `streamText` (with `maxRetries: 0`, billing resolved per attempt) and pulls until the first text delta; once a delta has been yielded to the consumer, errors propagate unchanged and no text is yielded twice

## 3. Tests

- [x] 3.1 Unit-test the delay function directly: exponential progression 2/4/8/16 then capped at 30s, jitter stays within `[0, capped]`, `Retry-After`/`retry-after-ms` honored only when `0 ≤ ms ≤ cap`
- [x] 3.2 Provider retry tests against a fake `fetch`: connection-refused-then-success resolves `ok` with wire calls = failures + 1; `401`/`402`/`403`/other-4xx short-circuit after exactly one wire call; all-`503` exhausts after 11 wire calls and classifies `err` as `type: "provider"`, `retryable: true`
- [x] 3.3 Abort test: an `AbortSignal` fired during the backoff sleep re-throws immediately without further wire calls and without waiting out the delay
- [x] 3.4 Streaming tests: failure before the first delta is retried under the policy; failure after a delta propagates without retry and previously yielded text is never re-emitted

## 4. Verify

- [x] 4.1 Run `tsc -p tsconfig.json` and `bun test` in `harness/`; format changed files with `bun run format:file`
