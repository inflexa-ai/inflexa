## Why

Reference datasets install strictly one file at a time (`store.ts:946` walks datasets, `store.ts:872` walks their artifacts, both `await` inside `for…of`). A recommended install is 42 files from a dozen different publishers, so the connection sits idle for most of the transfer.

## What Changes

- Datasets install **4 at a time** through a `p-queue` limiter, instead of one after another. Concurrency is across *datasets*, not within one: 38 of the catalog's 55 datasets carry exactly one artifact, so a within-dataset queue would idle just as much.
- Results stay in **plan order** regardless of completion order, so the installed summary and its tests are unaffected by scheduling.
- Staging becomes **per-dataset** even under a fixed `attemptId` test seam, which concurrency would otherwise let datasets delete out from under each other.
- The readout's in-flight segment generalizes from one file to the **active set**: `4 in flight 612.0 MB/2.4 GB`.
- **NEW DEPENDENCY**: `p-queue` in `cli` (approved for this change).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-data-provisioning`: transfers run bounded-concurrently, and the progress readout reports the in-flight set rather than a single in-flight file.

## Impact

- `src/modules/refs/store.ts` — the install loop, the `artifact_bytes` event gains artifact identity, staging isolation.
- `src/modules/refs/commands.ts` — in-flight tracking keyed by artifact.
- `cli/package.json` — `p-queue`.
- Tests: `store.test.ts` (event ordering is now per-artifact, not global), `commands.test.ts`.
