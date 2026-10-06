## Why

The CLI launched each sandbox on `ghcr.io/inflexa-ai/sandbox-base:latest`, a moving tag. No path pulls that tag again by itself: the start of a sandbox does not pull, and `inflexa upgrade` does not pull. Harness 0.43 changed the exec protocol of sandbox-server (inflexa-ai/inflexa#569). Thus an updated CLI kept the old `:latest`, and each exec failed with 401.

## What Changes

- The default of `harness.sandboxImage` is the build tag of the runtime image whose sandbox-server speaks the exec protocol of the harness that the CLI pins. A moving tag is never the default.
- A CLI update that moves the pin leaves the new image absent. The sandbox gate then refuses with the `inflexa sandbox pull` hint, and the pull downloads the new pair.

## Capabilities

### New Capabilities

### Modified Capabilities

- `lib-store-provisioning`: the default image is a pinned build tag, and the pull is the upgrade path of that pin.

## Impact

- `cli/src/modules/libs/images.ts` (`SANDBOX_IMAGE`), and the header of `cli/src/modules/libs/pull.ts`.
- Each harness bump that changes the exec protocol must move the pin.
