# Design: Add Request Timeout

## Context

The provider sends each LLM request with no timeout of its own (`src/providers/ai-sdk.ts:435-437`). The only cancellation is the abort signal of the caller. Thus the default transport limit of the host runtime, at approximately 5 minutes, aborts a request to a slow local model. The failure surfaces as `UND_ERR_HEADERS_TIMEOUT`, which `classifyProviderError` marks as retryable (`src/providers/errors.ts:182-183`). The envelope then makes up to 10 more attempts (`src/providers/ai-sdk.ts:22`), and the user sees minutes of silence.

Two hardcoded caps compound the problem. The ad-hoc router aborts at 10 seconds (`src/tools/ad-hoc-router.ts:17`). The planner aborts at 10 minutes (`src/tools/research/generate-plan.ts:70`).

## Goals / Non-Goals

**Goals:**

- One configured value lets a slow local model complete a request on every provider path.
- A spent timeout surfaces as a clear failure, not as silent retries.
- Absent configuration keeps the current behavior, byte for byte.

**Non-Goals:**

- The harness does not raise the transport floor of the host runtime. The embedder owns its `fetch` realization.
- No per-call or per-agent timeout override. One value per provider config.
- No change to the backoff delays of the envelope. Only the retry count becomes configurable.
- No change to the embedding client (`src/providers/embedding.ts:46`). An embedding input is small, and its SDK defaults stay.

## Decisions

### 1. The timeout bounds each silent interval, per attempt

`requestTimeoutMs` bounds the wait from the send of one attempt until its response headers arrive. After the response starts, the same value bounds each silent gap between two body chunks. Thus one configured value covers a slow prompt phase and a stalled stream. A stream with steady tokens never trips it, whatever its total length. For a non-streaming call the response starts when the model completes its output, thus the value covers the full generation time there.

Alternative: bound the whole call with `AbortSignal.timeout` on `abortSignal`. Rejected, because that aborts a healthy long stream, and because one window would span all envelope attempts. Alternative: bound the response start only. Rejected, because the CLI companion lifts the transport idle cut, and a post-start stall would then hang without any bound.

### 2. The guard is a fetch wrapper inside `createConfiguredAiSdkProvider`

When `requestTimeoutMs` is set, the provider wraps the effective fetch (`config.fetch ?? globalThis.fetch`). Each fetch call arms one timer. The timer aborts a dedicated controller with a typed `RequestTimeoutError` reason. The wrapper composes that signal with `init.signal` through `AbortSignal.any`.

When the response headers arrive, the wrapper wraps the body stream. Each received body chunk arms the timer again, and the end of the body clears it. One fetch call is one attempt, because the SDK retries are off (`maxRetries: 0`), so the window is per attempt by construction.

Alternative: a timeout option on `generateText`. Rejected, because the AI SDK exposes only `abortSignal`.

### 3. A guard abort classifies as `{ type: "provider", retryable: true }`

The rejection reason is the `RequestTimeoutError` instance, not a DOMException named `AbortError`, thus `isAbortError` (`src/providers/ai-sdk.ts:112`) does not swallow it as a cancellation. `errors.ts` detects the sentinel on the cause chain and returns a retryable provider error whose message names the configured value. This keeps parity with the transport timeout of today, which classifies as a retryable connection error (`src/providers/errors.ts:182-183`). The envelope logger records each backoff, so a long retry run stays observable.

Alternative: a new `timeout` member in the `ProviderError` union. Rejected, because the union change ripples through each consumer for no behavioral gain. Alternative: `retryable: false`. Rejected, because the current behavior retries a transport timeout, and parity is the requested outcome.

### 4. The provider advertises the limit on the `ChatProvider` seam

`ChatProvider` gains an optional readonly `requestTimeoutMs`. `createConfiguredAiSdkProvider` sets it from its config. A consumer that must scale a cap reads it from the provider instance that already rides in its deps. Precedent: `EmbeddingProvider.dimensions` (`src/providers/types.ts:122-130`) — the provider, not a harness constant, is the source of its own limit.

Alternative: thread a separate value through each deps bag at assembly. Rejected, because it duplicates the source of truth and touches every composition site.

### 5. The router and the planner derive their caps, with the constants as floors

- Router: effective timeout = `deps.timeoutMs ?? max(AD_HOC_ROUTER_TIMEOUT_MS, provider.requestTimeoutMs ?? 0)`. The `deps.timeoutMs` seam stays as an explicit override for tests.
- Planner: effective guard = `max(PLAN_TIMEOUT_MS, provider.requestTimeoutMs ?? 0)`, read from the conversation provider in the tool deps (`src/agents/conversation-agent.ts:251`). The single wall-clock guard stays, per the planning-enhancements spec. No per-attempt timer is added.

The `max` form means that a configured value can only lengthen a cap, never shorten one.

### 6. The transport floor belongs to the embedder fetch seam

The harness must not import `undici`, for the same reason that the `Logger` seam names no logging library: a published package must not push a dependency onto a consumer. The doc comment on `requestTimeoutMs` states the contract: the supplied fetch must permit a silent wait of at least this value. The CLI companion change realizes that contract for its runtime.

### 7. The retry count is configurable

Both arms of `AiSdkProviderConfig` gain an optional `maxRetries`. The envelope uses it in place of `RETRY_MAX_RETRIES = 10` (`src/providers/ai-sdk.ts:22`), and an absent field keeps the default of 10. The worst case for a dead endpoint is `(maxRetries + 1) * requestTimeoutMs` of silence. Accepted, because the envelope logger records each backoff.

## Risks / Trade-offs

- [The embedder sets `requestTimeoutMs` above the floor of its own fetch] → The transport cuts first and the old retryable-connection-error path runs. Mitigation: the config doc states the contract, and the companion change realizes the floor in the CLI.
- [A middle hop, for example a user proxy, cuts the connection earlier] → Out of harness control. Mitigation: the guard error message names the configured value, so a shorter observed cut points at the transport, not at the harness.
- [A large value delays the surface of a genuinely dead endpoint] → Accepted. A dead endpoint usually fails the connect fast, and the connect failure stays retryable.

## Migration Plan

No data changes. An absent `requestTimeoutMs` keeps the current behavior, thus the rollout is inert until an embedder sets the field.

## Open Questions

None.
