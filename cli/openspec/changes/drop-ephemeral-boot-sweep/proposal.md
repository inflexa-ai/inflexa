## Why

The harness replaces turn-scoped ephemeral execution with durable adhoc runs, so the CLI's pre-launch cancellation of `ephemeral:` workflows is obsolete and would depend on an API the harness no longer exports. The embedder must adopt the new workflow/config surface when it consumes that harness version.

## What Changes

- Remove the `sweepEphemeralWorkflows` import, boot seam, pre-launch call, and ordering assertions.
- Wire the harness's `runAdhoc` workflow dependency bundle in place of the retired ephemeral runner bundle.
- Rename the CLI-resolved resource-policy field from `ephemeral` to `adhoc`.
- Update harness-runtime tests and comments to describe normal recovery for adhoc runs.
- Keep the existing run sidebar unchanged; it already reads ordinary run and step ledger rows.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-runtime`: Remove the ephemeral zero-recovery boot duty and adopt the durable adhoc-run composition surface.

## Impact

- `src/modules/harness/runtime.ts` boot seams, workflow assembly, and tests.
- `src/modules/harness/config.ts` resource-policy parsing/resolution and tests.
- The `@inflexa-ai/harness` integration surface consumed by the CLI; no new dependency and no UI change.
