# Add Request Timeout

## Why

A slow local model does not start its response before the default transport limit of the host runtime aborts the request, at approximately 5 minutes. No provider option controls this limit. Thus a user of a local model cannot complete a data profile or a chat turn, and no configuration value can repair it.

## What Changes

- Add an optional `requestTimeoutMs` field to both arms of `AiSdkProviderConfig`.
- Add an optional `maxRetries` field beside it. The retry envelope uses the value in place of the fixed `RETRY_MAX_RETRIES` constant.
- When the field is set, the provider bounds each silent interval of a request attempt. If no response start and no body chunk arrives within `requestTimeoutMs`, the provider aborts the attempt and classifies the failure as a retryable timeout.
- The abort guard composes with the abort signal of the caller. When the field is absent, behavior does not change.
- The `fetch` realization of the embedder owns the transport floor. The config field documents that contract: the supplied fetch must permit a silent wait of at least `requestTimeoutMs`.
- Add an optional readonly `requestTimeoutMs` to the `ChatProvider` interface. The configured provider advertises its own limit, and a consumer reads it from the provider instance in its deps.
- Scale the ad-hoc router cap. When the provider advertises a limit, the router timeout is the maximum of `AD_HOC_ROUTER_TIMEOUT_MS` and that limit.
- Scale the planner wall-clock guard in the same way: the maximum of `PLAN_TIMEOUT_MS` and the advertised limit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-providers`: the `ChatProvider` seam gains an optional advertised request-timeout limit.
- `ai-sdk-provider-runtime`: the provider configuration accepts a request timeout, the provider enforces it per attempt, and the embedder fetch contract carries the transport floor.
- `adhoc-analysis-execution`: the router timeout derives from the configured request timeout of its provider.
- `planning-enhancements`: the planner wall-clock guard derives from the configured request timeout of its provider.

## Impact

- `harness/src/providers/ai-sdk.ts`: the config type, the guard around `generateText` and `streamText`, and the timeout classification.
- `harness/src/providers/errors.ts`: the classification of a guard abort as a timeout, distinct from a caller abort.
- `harness/src/providers/types.ts`: the `ChatProvider` interface gains the optional advertised limit.
- `harness/src/tools/ad-hoc-router.ts`: the effective timeout derives from the provider in the deps.
- `harness/src/tools/research/generate-plan.ts`: the wall-clock guard derives from the provider in the deps.
- A companion change in the `cli` spec tree threads the value from the CLI configuration file. That change is not part of this one.
