## Why

Two production steps whose science had fully succeeded were hard-failed by their
own bookkeeping, over one data-input file each that the step never referenced:

```
[post-step.reconcile] external registration failed for T3S2:
  1 row(s) rejected, 51/52 local artifact(s) registered
  runs/{run}/T3S2/data/samplesheet.csv: not referenced by any activity
```

The registry contract the fail-fast rule was written against is stricter than
the real one. The registry returns HTTP 200 and commits per leaf and per
activity, with no batch-wide rollback — some rows being accepted while others
are rejected is a normal outcome, not an error — and it reports a file that no
activity references in the same `failed[]` bucket as a genuine rejection. Such a
row registers nothing, so it puts no bytes at risk.

The throw also precedes byte sync. Both steps had 51 real artifacts registered
with an `artifact_id` and never uploaded: the outputs were orphaned *by* the
rule written to prevent orphaning, on exactly the case where its rationale
inverts.

## What Changes

- Severity follows what a rejection puts at risk, not the fact of a rejection.
  A rejected **output** — bytes that exist nowhere but the step tree — stays
  terminal, and so does a rejection cascaded from a real one.
- `failedCount` (surfaced as `externalFailed`) and `failed[]` SHALL both exclude
  a rejection of a file no activity in the payload references, so the fail-fast
  message names only what cost the step something. Such a rejection is reported
  across the seam in `notCounted`, and `registerStepArtifacts` logs it with its path
  and the registry's reason — not counting a rejection is never licence to drop
  it silently.
- Byte sync SHALL be attempted whatever registration returned, including when it
  threw. Sync covers only the rows registration accepted (`artifact_id IS NOT
  NULL AND file_id IS NULL`), so it uploads exactly those and reaches nothing
  rejected. A registration error stays the surfaced cause; a sync failure that
  follows it is logged, never substituted.

## Capabilities

### New Capabilities

None. This narrows existing requirements in `artifact-manifest`.

### Modified Capabilities

- `artifact-manifest`: registry-rejection severity is per-rejection rather than
  per-batch, and byte sync is independent of the registration outcome. The
  content-attestation invariants are untouched — no hashless edge is registered,
  and every surviving output is still re-hashed from disk.

## Impact

- `src/execution/artifact-registration.ts` — surfacing of uncounted rejections.
- `src/workflows/sandbox-step.ts` — sync attempted on the registration-failure
  path, registration error re-raised as the cause.
- The managed `ArtifactRegistry` adapter — classifies rejections and excludes
  not-referenced rows from `failedCount`.
