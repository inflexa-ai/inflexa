# Tasks: Adopt SDK Chunk Timeout

## 1. The wrapper shrinks and lifts

- [x] 1.1 In `wrapFetchWithRequestTimeout` (`src/providers/ai-sdk.ts`), delete the body-stream wrapping. Keep one timer from send until the fetch promise settles, with the abort-listener and unref behavior.
- [x] 1.2 Add `timeout: false` to the forwarded init in the wrapper. Justify the cast: the key is an untyped Bun extension, probe-proven, inert under Node.
- [x] 1.3 Update the `requestTimeoutMs` doc comment: the harness lifts the Bun idle cut, and under Node the undici floor stays above 300 seconds.

## 2. The SDK bound and the stream surface

- [x] 2.1 Pass `timeout: { chunkMs: requestTimeoutMs }` to `streamText` when the config sets the value. Do not pass it to `generateText`, because `chunkMs` is inert there.
- [x] 2.2 In `chatStream`, map the SDK `abort` stream part to a terminal error event that names the timeout. Keep the cancellation path when the caller signal is aborted. Read the exact part shape from the installed SDK first.
- [x] 2.3 In `src/providers/errors.ts`, classify an error named `TimeoutError` as `{ kind: "provider", retryable: true }`, beside the `RequestTimeoutError` path.

## 3. Tests

- [x] 3.1 Update the guard tests: the response-start guard trips before headers, and no timer survives after headers arrive.
- [x] 3.2 Fake-server tests through the real SDK: a stalled stream trips `chunkMs`, a keep-alive does not reset it, and a steady long stream survives.
- [x] 3.3 `chatStream` tests: a mid-stream timeout yields a terminal error event, and a caller abort stays a cancellation.
- [x] 3.4 Classification tests: `TimeoutError` is a retryable timeout, and a caller-signal expiry does not loop the envelope.

## 4. Close out

- [x] 4.1 Run `bun run format:file` on the changed source files.
- [x] 4.2 Run `tsc -p tsconfig.json` and `bun test` in `harness/`.
