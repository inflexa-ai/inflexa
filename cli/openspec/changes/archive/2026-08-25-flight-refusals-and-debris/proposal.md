# Proposal: flight-refusals-and-debris

## Why

A load-check refusal of a detached flight reports nowhere. The flush child
runs with ignored stdio, and the flight rows delete at the end of the run.
The agent then asks again without a reason, the user approves again, and the
same failure repeats. The failed bytes wait for a manual `store reclaim`
that most users never run. A flight-claim query failure also reads as
contention, because the flush folds the error branch into "joined".

## What Changes

- The flight rows gain a terminal `failed` state with a bounded reason. A
  retry of the same spec claims the same row, thus the failure clears
  naturally.
- `store ls` lists the failed flights with their reasons and the kept
  bytes. The sidebar keeps one failure line per failed flight.
- THE PACKAGE FLOW prompt teaches the pull: read `store ls` before a second
  ask for a package that stays missing.
- Debris — content that neither a farm nor the graph references — collects
  automatically: at app idle, and after a flush that ended with refusals.
  `store reclaim` keeps its meaning and its approval gate.
- A flight-claim query failure surfaces as its own refusal, never as
  "joined".

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `package-store-management`: the durable refusal record, the failed-flight
  surfaces, the prompt pull rule, the debris collection, and the
  claim-error refusal.

## Impact

- `cli/src/db`: migration 7 rebuilds `package_store_flights` with the
  `failed` state and a `message` column.
- `cli/src/modules/libs/store_flight.ts` and `store.ts`: the settle path,
  the claim-error refusal, and the debris trigger.
- `cli/src/tui`: the sidebar failure line, and the idle collection hook.
- `cli/src/modules/harness/inflexa_tool.ts`: one prompt sentence.
- `images/sandbox-provisioner/provision.py`: the `reclaim --debris` mode.
  Its spec rule lands in the harness tree at sync, as the prune rule did.
