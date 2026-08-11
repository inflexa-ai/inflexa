# Adopt SDK Chunk Timeout

## Why

The request-timeout guard wraps the response body by hand, and that stream surgery caused the timer-leak class of bugs. The installed `ai@7.0.28` carries a native `timeout` setting whose `chunkMs` bounds body gaps content-aware: a keep-alive byte does not reset it, but our wrapper resets on any byte. A probe against the installed package proved the semantics and the gaps of both mechanisms.

## What Changes

- The fetch wrapper shrinks to a response-start guard. The timer clears when the headers arrive, and the body-stream wrapping is deleted. This keeps the pre-headers window bounded, because the probe proved that `chunkMs` never trips before the response starts.
- The wrapper adds `timeout: false` to the fetch init when the guard installs. The transport lift moves from the embedder into the harness. The key is inert under Node and lifts the idle cut under Bun.
- The provider passes `timeout: { chunkMs: requestTimeoutMs }` to `streamText`, so the SDK owns the body gaps. Non-streaming calls keep the response-start guard as their full bound, because headers arrive at completion there.
- `classifyProviderError` learns the `TimeoutError` DOMException as a retryable provider timeout. The probe proved that it carries no cause, no status, and a name that no current path matches.
- `chatStream` maps the `abort` stream part to an error event. The probe proved that a mid-stream timeout otherwise ends the stream quietly with partial text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-sdk-provider-runtime`: the silent-interval guard decomposes into the response-start wrapper and the SDK `chunkMs`. The transport-floor contract flips to a harness-supplied lift. The timeout classification covers the `TimeoutError` DOMException.
- `harness-providers`: the `chatStream` seam surfaces a mid-stream timeout as an error event, never as a quiet end.

## Impact

- `harness/src/providers/ai-sdk.ts`: the wrapper, the `timeout` call option, and the `chatStream` abort-part mapping.
- `harness/src/providers/errors.ts`: the `TimeoutError` classification.
- The companion change `retire-cli-transport-lift` removes the CLI-side lift that this change absorbs.
