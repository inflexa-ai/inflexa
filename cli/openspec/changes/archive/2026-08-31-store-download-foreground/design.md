# Design: store-download-foreground

## Context

`runStoreDownload` has two paths: the detached start, and the hidden in-process worker (`store.ts:1075-1080`). A Kubernetes Job needs the worker semantics behind a public flag, with an exit code and a final report. A detached child writes nothing to the pod log, and it dies with the pod.

## Goals / Non-Goals

**Goals:**

- A supported foreground mode with the outcome in the exit code.
- The refusal of a foreground run while a detached transfer is live.

**Non-Goals:**

- No change to the detached default, the TUI, or the wizard.
- No progress stream to stdout. The row carries the progress, and `store ls` reads it.

## Decisions

- **`--foreground` wraps the existing worker.** The branch runs `runCatalogTransfer` in process, then reads the corrected report and prints the final state. A second engine was rejected: one transfer body must exist.
- **A live transfer refuses the foreground run, with exit code 1.** The lock would make the second run a silent no-op, and a silent no-op in a Job reads as success.
- **A `failed` settle exits 1 with the recorded message.** The Job retries on its own schedule, and the receipt makes the retry idempotent.
- **The transfer body is injectable for the proof.** The real body needs the network, and the test needs only the settle semantics.

## Risks / Trade-offs

- [The pod dies mid-transfer] → The staging fingerprint marks the store as interrupted, and the next run repairs. This is the existing contract.

## Migration Plan

None. The flag is additive.

## Open Questions

None.
