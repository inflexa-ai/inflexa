# Tasks: Add Request Timeout

## 1. Provider seam and configuration

- [x] 1.1 Add the optional readonly `requestTimeoutMs` field to `ChatProvider` in `src/providers/types.ts`, with a doc comment that names the silent-interval semantics.
- [x] 1.2 Add the optional `requestTimeoutMs` field to both arms of `AiSdkProviderConfig` in `src/providers/ai-sdk.ts`. The doc comment MUST state the embedder fetch contract: the supplied fetch must permit a silent wait of at least this value.
- [x] 1.3 Add the optional `maxRetries` field to both arms of `AiSdkProviderConfig`. The envelope uses it in place of `RETRY_MAX_RETRIES`, with 10 as the default.

## 2. The guard

- [x] 2.1 Add a typed `RequestTimeoutError` with the configured value in its message.
- [x] 2.2 Wrap the effective fetch in `createConfiguredAiSdkProvider`. Arm one timer per fetch call. On expiry, abort a dedicated controller with the `RequestTimeoutError` reason. Compose that signal with `init.signal` through `AbortSignal.any`. After the headers arrive, wrap the body stream. Arm the timer again on each body chunk, and clear it at the end of the body.
- [x] 2.3 Set `requestTimeoutMs` on the returned provider instance.
- [x] 2.4 Classify the sentinel in `src/providers/errors.ts` as `{ type: "provider", retryable: true }`, before the connection-error and abort paths.
- [x] 2.5 Unit tests: the guard trips on a slow response start and on a stalled body, and a steady stream does not trip it.
- [x] 2.6 Unit tests: a caller abort stays a cancellation, and the envelope retries a guard expiry with a fresh window.
- [x] 2.7 Unit test: an absent field installs no wrapper.
- [x] 2.8 Unit tests: a configured `maxRetries` bounds the envelope, and an absent field keeps the limit of 10.

## 3. Derived caps

- [x] 3.1 Router (`src/tools/ad-hoc-router.ts`): the effective timeout is `deps.timeoutMs ?? max(AD_HOC_ROUTER_TIMEOUT_MS, provider.requestTimeoutMs ?? 0)`. Update the doc comment of the `timeoutMs` dep.
- [x] 3.2 Planner (`src/tools/research/generate-plan.ts`): the wall-clock guard is `max(PLAN_TIMEOUT_MS, provider.requestTimeoutMs ?? 0)`, read from the conversation provider of the deps.
- [x] 3.3 Unit tests: each cap uses the advertised value when it is larger, and the default when the field is absent.

## 4. Close out

- [x] 4.1 Run `bun run format:file` on the changed source files.
- [x] 4.2 Run `tsc -p tsconfig.json` and `bun test` in `harness/`.
