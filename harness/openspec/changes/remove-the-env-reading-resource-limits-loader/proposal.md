# Remove the env-reading resource-limits loader

## Why

`loadResourceLimits` reads `SANDBOX_MAX_CPU`, `SANDBOX_MAX_MEMORY_GB`, and `SANDBOX_MAX_GPU_COUNT` straight off `process.env`. Nothing calls it — not the harness, not the CLI, not managed Cortex. It is not exported from the barrel either, so it is reachable only through a deep import of `config/resource-limits.js`.

Both embedders already do this the supported way, and neither goes near the function. Cortex validates those three variables in its own Zod schema and passes the result as `SandboxClientConfig.resourceLimits`; the CLI passes `cfg.resourcePolicy.perStep`. The harness receives ceilings as configuration and validates their shape with `ResourceLimitsSchema` / `parseResourcePolicy`.

So the function is not merely unused, it is a trap. It reads like the supported entry point for loading ceilings, and a caller who took it would silently bypass the embedder's validated configuration and pick up raw environment instead — two views of the same three values, free to disagree, with the environment winning in whichever code path happened to call it. Deleting it leaves one way to configure ceilings.

This is the harness's only remaining ambient environment read outside telemetry. `lib/otel.ts` reads `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_SERVICE_NAME`, but only inside `initOtel`, which the harness never calls itself — `bootHarness` takes `initTelemetry` as an injected dep defaulting to a noop, and those two variables are OpenTelemetry's own standard contract. That one stays.

## What Changes

- Delete `loadResourceLimits` and the two parsing helpers it alone used (`parsePositiveNumber`, `parseNonNegativeInt`).
- `ResourceLimitsConfigError`, every schema, `clampResources`, and `parseResourcePolicy` are untouched — the embedder-supplied path is the whole surface now.
- Restate the module header: ceilings arrive as configuration, and nothing in this module reads the environment.

No embedder change. `SANDBOX_MAX_*` keeps its meaning for hosts that choose to name their ceilings that way — Cortex does — but reading it is now unambiguously the host's job, done once, in the host's own validated schema.

## Capabilities

### Modified Capabilities

- `dynamic-resource-allocation`: cluster ceilings are supplied by the embedder as configuration rather than read from the environment by the harness. The clamping contract is unchanged.

## Impact

- `src/config/resource-limits.ts` — the loader and its two helpers.

Reachable through the `./*` export map, so a consumer deep-importing `loadResourceLimits` would break. There is none: not in this repo, not in managed Cortex, and the CLI takes only types from the module. It also could never have been used by the CLI, which requires no `SANDBOX_MAX_*` and would have hard-failed at boot on a machine with none set. Shipped as a patch on that basis.
