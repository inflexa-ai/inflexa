# harden-data-profile-claim — Tasks

## 1. The claim CAS carries the seed invariant

- [x] 1.1 `state/data-profile.ts`: add `AND seed_input_file_ids IS NOT NULL AND
      jsonb_array_length(seed_input_file_ids) > 0` to the `WHERE` of `tryStartDataProfile`,
      `tryRerunDataProfile`, and `tryRetryDataProfile`. Replace each function's doc with the WHY (D1):
      the invariant is the ledger's, not one orchestration's; a pre-read cannot enforce it.
- [x] 1.2 `tasks/data-profile.ts`: the seed pre-check rejects `[]` as well as `NULL`
      (`seeded === null || seeded.length === 0`). Re-word its comment: advisory, produces the operator
      message; the CAS is the enforcement (D1/D2).
- [x] 1.3 `tasks/data-profile.ts`: rewrite `triggerDataProfile`'s JSDoc — it currently claims "two
      transitions in sequence: pending→running, completed→running" and omits both the seed guard and
      the NULL claim.

## 2. Drift signature on the manifest and the result

- [x] 2.1 `execution/staged-input.ts`: add `readonly mtimeMs: number` with a doc stating it is an
      opaque, embedder-supplied epoch-ms value the harness never interprets (D3).
- [x] 2.2 `state/data-profile.ts`: widen the `DataProfileStatus.result` type with
      `inputFiles?: { fileId: string; size: number; mtimeMs: number }[]`. Optional on read — a result
      written before this change has none, and a consumer treats absence as drift (D3).
- [x] 2.3 `tasks/data-profile.ts`: `completeDataProfile` call site records
      `inputFiles: stagedInputs.map(f => ({ fileId: f.fileId, size: f.size, mtimeMs: f.mtimeMs }))`
      beside the existing `inputFileIds`.

## 3. Schema and barrel accuracy

- [x] 3.1 `state/init.ts`: drop `NOT NULL` from the `data_profile_status` column in the `CREATE TABLE`
      (keep `DEFAULT 'pending'`). Keep the `ALTER … DROP NOT NULL` migration — pre-existing databases
      still carry the constraint and the ALTER is idempotent. Comment the WHY (D4).
- [x] 3.2 `index.ts`: correct the data-profile barrel comment — `triggerDataProfile` no longer "claims
      pending/completed rows only".

## 4. Tests

- [x] 4.1 `state/data-profile.test.ts`: `tryStartDataProfile` refuses a `'pending'` row with a NULL
      seed, refuses one with `[]`, and claims one with a non-empty seed. Same three for
      `tryRerunDataProfile` (`'completed'`) and `tryRetryDataProfile` (`'failed'`).
- [x] 4.2 `state/data-profile.test.ts`: the clear→reseed→claim lifecycle — clear nulls status *and*
      seed; `tryStartDataProfile` refuses the cleared row; after a seed upsert it claims.
- [x] 4.3 `tasks/data-profile.trigger.test.ts`: **replace** the tautological "passes a seeded row
      through to a claimed start" (it seeds `status='pending'`, so the pre-existing branch claims it
      and the NULL clause is never exercised). Seed `status = NULL` + a non-empty seed and assert
      `"started"` — this is the real cleared-then-reseeded production state (D5). Keep a separate
      `'pending'` case so both claim clauses are pinned.
- [x] 4.4 `tasks/data-profile.trigger.test.ts`: `triggerDataProfile` returns `"failed"` and leaves the
      row untouched for a `[]` seed (not just a NULL one).
- [x] 4.5 Verify by deletion: temporarily remove `OR data_profile_status IS NULL` from
      `tryStartDataProfile` and confirm 4.3 fails. Restore.

## 5. Gate

- [x] 5.1 `bun run typecheck` && `bun run lint` clean; `cd harness && bun test` green.
