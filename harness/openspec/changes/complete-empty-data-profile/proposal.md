## Why

An analysis with no input files has no profile state that says "done". The trigger refuses
an unseeded analysis and an empty manifest, so the ledger row stays at `pending` or NULL. A
consumer reads that row as "not profiled", and the user sees a profile that never starts.

The body already knows the correct answer. When the workflow body receives an empty
manifest, it completes the profile as a no-op (the data-profile-init spec). But no trigger
can reach that path: every claim into `running` requires a seed that names files, and the
trigger refuses an empty seed before any claim. Thus the harness holds two answers for one
condition, and only the refusal is reachable.

A profile describes files. An analysis with no files has nothing to describe, and thus its
profile is complete at once. There is no reason to claim the row, to mint an authorization,
or to start a workflow for zero files.

## What Changes

- **A new ledger operation, `completeEmptyDataProfile`.** It stamps a row `completed` with
  no result, no error, no workflow id, and the seed `[]`. The CAS refuses a live run and a
  row whose seed names files. The seed predicate is the negation of the claim conjunct, so
  a claim and an empty-set completion can never both win on one row.
- **The trigger takes the empty-set route.** When the manifest is empty and the seed names
  no file, `triggerDataProfile` stamps the row and returns the new result `"completed"`. No
  claim runs, and no workflow starts. An empty manifest against a seed that names files
  stays a refusal, because the caller and the ledger diverge.
- **The unseeded refusal narrows to a manifest that names files.** A NULL seed or `[]`
  against a non-empty manifest still means that the caller skipped the seed.

## Impact

- `src/state/data-profile.ts`, `src/state/index.ts`: the new operation.
- `src/tasks/data-profile.ts`: the trigger route and the `"completed"` result member.
- `DataProfileTriggerResult` gains a member. An embedder with an exhaustive switch on the
  result must add the case when it takes this version.
- `clearDataProfile` stays. An embedder can keep the "not profiled" clear, or it can seed
  `[]` and trigger to reach `completed`.
