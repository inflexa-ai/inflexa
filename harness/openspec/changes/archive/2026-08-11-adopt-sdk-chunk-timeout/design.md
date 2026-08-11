# Design: Adopt SDK Chunk Timeout

## Context

The guard in `wrapFetchWithRequestTimeout` (`src/providers/ai-sdk.ts`) bounds each silent interval by hand. It wraps the response body, re-arms a timer per chunk, and clears it at the end. The body wrapping is the fragile part — the timer-leak finding of the last review lived there.

A probe against the installed `ai@7.0.28` measured the native `timeout` setting:

- `chunkMs` bounds the wait before the first content chunk and each later gap. A keep-alive SSE comment does not reset it. But its timer arms at the `stream-start` part, thus a pre-headers hang never trips it.
- `stepMs` and `totalMs` cover the pre-headers window, but they bound the whole step. A healthy stream longer than the value dies.
- A fired timeout is a bare `DOMException` named `TimeoutError`: no cause, no status, and `APICallError.isInstance` false.
- On a mid-stream timeout, stream iteration never throws. The stream ends quietly with partial text and an `abort` part.

## Goals / Non-Goals

**Goals:**

- Every window stays bounded: pre-headers, response start, and each body gap.
- The body-stream surgery is deleted.
- The transport lift ships in the harness, so each Bun embedder gets it without work.
- A mid-stream timeout surfaces as an error, never as silent truncation.

**Non-Goals:**

- No change to the retry envelope, the advertised `ChatProvider` limit, or the router and planner derivations.
- No change to the external meaning of `requestTimeoutMs`. Only the mechanism decomposes.

## Decisions

### 1. The windows decompose: wrapper to response start, SDK `chunkMs` after

The fetch wrapper keeps one timer from send until the response headers arrive, and then it clears. No body wrapping remains. `streamText` receives `timeout: { chunkMs: requestTimeoutMs }`, so the SDK owns each content gap. A non-streaming call keeps the wrapper as its full bound, because its headers arrive when the model completes.

Alternative: `chunkMs` alone. Rejected, because the probe proved that a pre-headers hang never trips it. Alternative: `stepMs` or `totalMs` for everything. Rejected, because they cap the total length of a healthy stream.

### 2. The harness supplies the transport lift

When the guard installs, the wrapper adds `timeout: false` to the fetch init. The key is a Bun extension: inert under Node, and it lifts the 300-second idle cut under Bun. Thus each Bun embedder gets a working timeout with zero composition work, per the embedder-first argument of the review thread.

The honest caveat rides in the config doc: under Node the undici floor stays. A Node embedder above 300 seconds still supplies a dispatcher-raised fetch.

### 3. `classifyProviderError` learns the `TimeoutError` DOMException

An error named `TimeoutError` classifies as `{ kind: "provider", retryable: true }`, beside the existing `RequestTimeoutError` sentinel path. One guard rides with it. The envelope rethrows without a retry when the caller signal is aborted. Thus a planner wall-clock expiry, whose abort reason is also a `TimeoutError`, never loops. The classification order and this invariant get a test each.

### 4. `chatStream` maps the `abort` part to an error event

The stream conversion in `chatStream` treats the SDK `abort` part as a terminal error event that names the timeout. Silent partial text becomes unrepresentable on the harness surface. The exact part shape comes from the installed SDK at implementation time, with a test against a fake stream.

## Risks / Trade-offs

- [The SDK `timeout` internals change in a future `ai` version] → The version is pinned. The tests drive a fake server through the real SDK, so a semantic drift fails loudly.
- [A future Bun release drops the `timeout: false` extension] → The regression surfaces as the old 300-second cut, and the cast comment records the probe.

## Migration Plan

No data changes. The external semantics of `requestTimeoutMs` stay, thus embedder configs keep their meaning.

## Open Questions

None.
