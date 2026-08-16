# Proposal: give-the-eyes-shared-memory

## Why

Seven looks of the second real report session failed with `Protocol error (Page.captureScreenshot): Unable to capture screenshot`. The record gate then refused with `never-seen`, thus the session ended with no recorded version.

A live A/B run pins the root cause. The eyes container starts with no `--shm-size`, and the podman default gives it a 64 MiB `/dev/shm`. The capture asks for the full page, and the bitmap of the 11,189 px session page is about 64 MB. The same container command with `--shm-size=1g` captures the same page cleanly.

## What Changes

- The ephemeral eyes realization (`src/modules/harness/eyes.ts`, `createEphemeralEyes`) adds `--shm-size=1g` to the container run args.
- A test pins the shm argument in the run args, beside the existing arg assertions.
- Nothing else about the eyes changes: the lifetime entrypoint, the count gate, the readiness probe, the mount, and the release stay as they are.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `harness-runtime`: the eyes-realization requirement gains the shared-memory allowance, because the capture bitmap of a tall page does not fit the runtime default.

## Impact

- Affected code: `src/modules/harness/eyes.ts`, `src/modules/harness/eyes.test.ts`.
- No contract change, no new dependency, no behavior change outside the container args.
- The harness-side capture fallback is a separate harness change, not this one.
