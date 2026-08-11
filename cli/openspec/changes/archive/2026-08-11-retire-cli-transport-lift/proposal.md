# Retire CLI Transport Lift

## Why

The harness change `adopt-sdk-chunk-timeout` moves the Bun transport lift into the provider guard. Thus each Bun embedder gets it free, and the CLI copy becomes dead weight with a duplicated rationale.

## What Changes

- Delete `buildTimeoutLiftingFetch` and `buildProviderFetch` from `src/modules/harness/runtime.ts`. The provider `fetch` returns to the auth-injecting fetch alone, present only with a credential source.
- The config threading stays: `requestTimeoutMs` and `maxRetries` still ride into the harness provider config through `pickRequestBounds`.
- The wrapper tests retire. The 401-refresh tests stay.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-runtime`: the transport-lift requirement retires, because the harness supplies the lift.

## Impact

- `cli/src/modules/harness/runtime.ts` and its test file.
- The harness pin must carry `adopt-sdk-chunk-timeout` for the lift to exist at runtime.
