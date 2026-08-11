# Wire Request Timeout

## Why

The Bun fetch of the CLI aborts each LLM request after 300 seconds of silence. A local model on small hardware often thinks longer than that before its first byte. No config value controls this cut. The harness change `add-request-timeout` adds the provider capability, and this change connects it from the CLI composition root.

## What Changes

- Add optional `requestTimeoutMs` and `maxRetries` fields to both arms of `models.connection` in the config schema.
- Thread the two values into the harness provider config in `providerConfigFor`, so the provider enforces and advertises them.
- Give the provider a fetch realization whose transport floor is at least the configured value. This lifts the 300-second Bun cut.
- An absent field keeps the current behavior in both modes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `model-connection`: the connection accepts `requestTimeoutMs` and `maxRetries` in both modes, and boot resolution carries them into the harness provider config.
- `harness-runtime`: the composition root gives the provider a fetch whose transport floor honors the configured value.

## Impact

- `cli/src/lib/config.ts`: the `models.connection` schema.
- `cli/src/modules/harness/runtime.ts`: `providerConfigFor`, and the fetch construction next to `buildAuthInjectingFetch`.
- The provider capability comes from the harness change `add-request-timeout`.
