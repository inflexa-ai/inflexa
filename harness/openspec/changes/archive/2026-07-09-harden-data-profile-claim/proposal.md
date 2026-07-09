# harden-data-profile-claim — Proposal

## Why

Review of `feat/chat-integration` surfaced three defects in the data-profile claim path, all of them
in code the branch either introduced or newly made load-bearing.

1. **The seed invariant is a TOCTOU, not an invariant.** `triggerDataProfile` reads
   `seed_input_file_ids` in one statement and claims the row in another
   (`tasks/data-profile.ts:462-473`). A concurrent `clearDataProfile` — which nulls status *and*
   seed on any non-`running` row (`state/data-profile.ts:184-192`) — can wipe the seed between the
   two. `tryStartDataProfile` then claims a NULL-status row into `running` with a NULL seed: exactly
   the "running with no recorded inputs" state the guard exists to prevent.

2. **An empty seed set passes the guard.** `upsertAnalysis` persists `inputFileIds ? JSON.stringify(…)
   : null` (`state/analyses.ts:51`), and `[]` is truthy — so an empty input set is stored as `[]`,
   not `null`. The guard checks `seeded === null` (`tasks/data-profile.ts:468`), so `[]` sails
   through and would profile zero files. Latent today (both orchestrated callers gate on a non-empty
   input set upstream) but the guard's stated contract is not the contract it enforces.

3. **The test for the branch's headline fix is a tautology.** `data-profile.trigger.test.ts:83`
   ("passes a seeded row through to a claimed start") seeds `data_profile_status = 'pending'`, so the
   claim is won by the *pre-existing* `= 'pending'` branch. Deleting the new `OR data_profile_status
   IS NULL` clause leaves the entire suite green, yet a cleared-then-reseeded analysis could never be
   re-profiled. The regression this branch fixed would silently return.

Separately, the CLI cannot detect that an input file's **content** changed in place: the drift
comparand a completed profile records is `result.inputFileIds`, and a fileId is derived from
`anchorId|path` only. The harness owns the persisted profile result, so the fix is harness-first: the
result must record enough per-file identity for an embedder to judge content drift, at stat cost.

## What Changes

- **The seed requirement moves into the CAS.** `tryStartDataProfile` and `tryRerunDataProfile` claim
  a row only when `seed_input_file_ids` is a non-empty JSON array. "A `running` row has a recorded
  input set" becomes a structural invariant of the ledger rather than a property of one caller's
  read-then-write. `triggerDataProfile`'s pre-check stays, demoted to what it actually is: the source
  of a precise operator message, not the enforcement.
- **An empty seed array is `unseeded`.** Both the SQL predicate and the JS pre-check treat `[]` and
  `NULL` identically.
- **`StagedInput` gains `mtimeMs`**, and a completed `DataProfileResult` records
  `inputFiles: {fileId, size, mtimeMs}[]` beside the existing `inputFileIds`. This is the drift
  comparand an embedder needs to notice an in-place content edit without re-hashing every input on
  every parity check. `inputFileIds` stays — it is the audit record of *which* files a profile
  covered, and is a different question from *were they the same bytes*.
- **`data_profile_status` is declared nullable at `CREATE TABLE`**, matching the `ALTER … DROP NOT
  NULL` the same `initCortexState` already runs. The end state is unchanged; the schema stops
  contradicting the null-collapse contract `loadDataProfileStatus` depends on.
- **Two stale doc comments are corrected**: the barrel's "claims pending/completed rows only"
  (`index.ts:182`) and `triggerDataProfile`'s JSDoc, neither of which describes the code any more.

## Capabilities

### Modified Capabilities

- **`data-profile-rerun`** — the claim CAS carries the seed invariant; an empty seed is unseeded.
- **`data-profile-init`** — the staged-input manifest and the persisted profile result carry a
  per-file drift signature.

## Non-goals

- Changing when an embedder *decides* to re-profile. The harness records the signature; the parity
  policy stays embedder-side (`cli/openspec/changes/harden-chat-turn-and-parity`).
- Backfilling `inputFiles` onto rows completed before this change. A completed row without
  `inputFiles` reads as drift and re-profiles once — the same self-heal the existing code already
  applies to a completed row with a null `result`.
