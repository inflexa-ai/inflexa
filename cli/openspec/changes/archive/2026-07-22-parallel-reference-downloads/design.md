## Context

`installReferenceDatasets` awaits `installDataset` per dataset, which awaits `downloadArtifact` per artifact. Every activation guarantee — staged attempt directory, atomic rename, receipt written last — is already per-dataset, so datasets are independent units of work; only the loop is serial.

## Goals / Non-Goals

**Goals:** four datasets in flight; unchanged activation, receipt, and verification semantics; deterministic output; a readout that stays honest with several files moving.

**Non-Goals:** concurrency within a dataset (single-artifact datasets dominate); resumable downloads; per-host rate limiting.

## Decisions

### Four datasets at a time, via `p-queue`

`p-queue` is a new `cli` dependency, approved for this change. Concurrency defaults to 4 and is overridable through `ReferenceInstallDeps` so tests can pin 1 (deterministic ordering) or 2 (interleaving).

`queue.clear()` is deliberately **not** used to stop work after a failure: p-queue never settles the promises of cleared tasks, so a `Promise.all` over them would hang. Instead each job checks a "something already failed" flag before starting, which lets every promise settle while still scheduling no new transfers after the first error.

### Plan order survives concurrent completion

Each job writes its result into its own index, so the returned `installed` list is in plan order no matter who finishes first, and the reported error is the lowest-indexed failure rather than whichever lost the race. Without this, the summary lines and the byte-stable JSON they feed would reorder run to run.

### Staging must be per-dataset, including under the test seam

`installDataset` derives `attemptRoot` from `deps.attemptId?.()` and `rm -rf`s it on entry and in `finally` (`store.ts:846-847`). A fixed seam value — which tests pass — gives every dataset the *same* attempt root, so concurrently one dataset's cleanup would delete another's staged files mid-install. The dataset discriminator therefore moves out of the default branch and is always appended: `${attemptId}-${sha256(dataset.id).slice(0, 8)}`. This is a correctness precondition for concurrency, not a tidy-up.

### The readout reports the in-flight set

`4 in flight 612.0 MB/2.4 GB` replaces `file 240.0 MB/3.1 GB`. The numerator sums bytes received across active artifacts; the denominator sums the sizes their upstreams declared. Both are measured or declared, never inferred — the existing ban on a plan-wide total is untouched, and this remains a statement about the active set only, which is why it is labelled "in flight".

When any active artifact declared no size the fraction is dropped and only the count renders, rather than summing a partial denominator that would read as complete. The segment disappears entirely between datasets, when nothing is open.

This requires `artifact_bytes` to carry `datasetId` and `path`: with one transfer at a time a bare delta was unambiguous, but four interleaved streams need attribution or the bytes land on whichever artifact started last.

Cumulative bytes and the windowed rate need no change — summing across connections is what they already do, and the aggregate rate becomes a more useful number than a single stream's.

## Risks / Trade-offs

- **Four connections to four publishers at once.** → Well inside what a browser opens; no upstream here is rate-limit sensitive at this scale, and the cap is a constant we can lower.
- **Interleaved failure reporting.** → Activation is per-dataset and atomic, so a mid-flight failure still leaves every other dataset either fully installed or untouched, exactly as before.
- **A new dependency for one call site.** → Accepted deliberately; the alternative was a hand-rolled limiter, and matching lumen's existing pattern was preferred.
