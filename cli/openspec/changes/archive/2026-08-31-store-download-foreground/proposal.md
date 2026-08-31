# Proposal: store-download-foreground

## Why

The managed service refreshes its lib-store PVC with a one-shot Kubernetes Job. `store download` detaches and exits at once, thus the pod dies and the child dies with it. The worker mode exists behind the hidden `--run-transfer` flag, but a hidden flag is not a contract that a Job can build on.

## What Changes

- `store download` gains `--foreground`: the transfer runs in the calling process, and the exit code carries the outcome.
- A live detached transfer refuses a foreground run, because two writers must not race one store root.
- The detached default does not change, and the hidden worker flag stays as the internal spelling.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `package-store-transfers`: the detached lifecycle gains the one sanctioned foreground exception, for a container whose main process must hold the pod open.

## Impact

- `src/cli/index.ts`: the option on the registration. The policy stays `approval`, and the effect class does not change.
- `src/modules/libs/store.ts`: the foreground branch of `runStoreDownload`, with the final row report and the exit code.
- `openspec/specs/package-store-transfers/spec.md`: the delta of this change.
