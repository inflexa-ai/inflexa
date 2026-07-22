## 1. Bounded-concurrency installs

- [x] 1.1 Add `p-queue` to `cli` dependencies.
- [x] 1.2 Always append the dataset discriminator to the staging attempt id in `installDataset`, so a caller-supplied fixed attempt id still yields one staging root per dataset (`store.ts:846-847`); this is the precondition for running datasets concurrently.
- [x] 1.3 Replace the sequential dataset loop in `installReferenceDatasets` with a `PQueue` capped at 4, overridable through `ReferenceInstallDeps` for tests. Write each result into its own index so the outcome stays in plan order, report the lowest-ordered failure, and skip unstarted datasets after a failure without `queue.clear()` (cleared tasks never settle, which would hang the await).

## 2. Attributed progress and the in-flight readout

- [x] 2.1 Add `datasetId` and `path` to the `artifact_bytes` event and emit them from the counting `Transform`.
- [x] 2.2 Track in-flight artifacts in a map keyed by dataset and path in `createReferenceDownloadProgress`; render `<n> in flight` plus the received/declared byte fraction only when every in-flight artifact declared a size.

## 3. Tests

- [x] 3.1 Rework `store.test.ts` event assertions to per-artifact ordering (start → bytes → completed for each artifact) rather than a single global sequence.
- [x] 3.2 Cover concurrency: more datasets than the cap all install; a fixed attempt id no longer collides; plan-order results and lowest-ordered failure hold when completion order differs.
- [x] 3.3 Cover the readout: interleaved deltas attribute per artifact, the fraction appears only when every in-flight artifact declared a size, and the segment clears when nothing is open.
- [x] 3.4 `bun run typecheck`, `bun run lint`, `bun test`, `bun run format:file` on changed sources, then a real sandboxed multi-dataset download via `XDG_DATA_HOME`.
