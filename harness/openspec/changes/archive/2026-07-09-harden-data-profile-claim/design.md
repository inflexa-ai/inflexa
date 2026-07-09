# harden-data-profile-claim — Design

## D1. The seed invariant belongs in the CAS, not in a pre-check

The current code deliberately keeps the seed check out of `tryStartDataProfile`, arguing that the
primitive "takes a pool directly and is not bound to the seed-first orchestration"
(`tasks/data-profile.ts:458-461`). That reasoning is sound about *layering* and wrong about *safety*:
the property being protected — a `running` row always names the files it is profiling — is an
invariant of the **ledger**, not of one orchestration. An invariant enforced by a read that precedes
the write is not enforced at all; it is a race with a comment on it.

So the predicate moves into both claim statements:

```sql
WHERE analysis_id = $2
  AND (data_profile_status = 'pending' OR data_profile_status IS NULL)
  AND seed_input_file_ids IS NOT NULL
  AND jsonb_array_length(seed_input_file_ids) > 0
```

`tryRerunDataProfile` (`completed → running`) takes the same two seed conjuncts, because
`clearDataProfile` can null the seed of a `completed` row just as easily as a `pending` one.
`tryRetryDataProfile` (`failed → running`) takes them too, for the same reason.

**Rejected: fold the check into a single statement that also reports why it failed.** Postgres can
tell us *that* zero rows matched, not *which* conjunct failed. Distinguishing "lost the race" from
"never seeded" needs a second read either way, and the pre-check already performs it on the path
where the answer matters.

**Consequence for `triggerDataProfile`.** The pre-check is retained and now documented as advisory:
it produces the precise `no seeded input set (caller skipped seeding)` operator message on the
common, non-racing path. On the racing path the CAS refuses, `tryRerun` refuses (status is NULL, not
`completed`), the status read returns null, and the trigger returns `"failed"` — the same answer it
returns today, but now reached without ever having created a bad row. The embedder is responsible for
not racing a clear against a seed; that is `harden-chat-turn-and-parity`'s D2.

## D2. `[]` and `NULL` are the same seed state

`upsertAnalysis`'s `COALESCE(EXCLUDED.seed_input_file_ids, cortex_analysis_state.seed_input_file_ids)`
means "a null seed does not overwrite the stored one". That is why `analyses.ts:51` writes `null` for
a missing set rather than `[]` — the null is a *sentinel for "don't update"*, not a value. An empty
array, by contrast, is a real value that means "zero files", and it is a state no profile should ever
run against.

Two call sites therefore change together:

- SQL: `jsonb_array_length(seed_input_file_ids) > 0` alongside `IS NOT NULL`.
- JS pre-check: `if (seeded === null || seeded.length === 0)`.

`jsonb_array_length` errors on a non-array jsonb. The column is only ever written from
`JSON.stringify(string[])`, so a scalar cannot appear; if a hand-edited row ever carried one, the
error surfaces through `tryMutation`'s `DbError` rather than silently claiming the row. That is the
correct failure direction.

## D3. Content drift needs a per-file signature, and stat is the right cost

`fileId = hash(anchorId|path)` is a *path* identity. Two profiles taken over the same paths with
different bytes compare equal, so an in-place edit is invisible.

The comparand becomes `(fileId, size, mtimeMs)` per file:

- **Why not the content hash?** `stageInputs` already computes SHA-256, but `enumerateInputFileIds`
  is deliberately its "hash-free twin" — it exists precisely so a parity check on every chat open
  costs stat/readdir, not a full read of every input. Inputs here are genomics files; re-hashing them
  on every open is not a trade-off worth making to catch an edit the user almost always makes through
  the input picker (which fires `prov.input_*` and re-triggers anyway).
- **Why size *and* mtime?** Either alone is weak: a same-size edit is common (fixed-width records), a
  same-mtime edit is possible with `touch -r` or a filesystem whose mtime granularity is coarse.
  Together they catch every realistic in-place edit.
- **Accepted miss:** an edit that preserves both byte length and mtime is not detected. This is stated
  in the spec as a bounded limitation, not left silent.

`StagedInput` gains `readonly mtimeMs: number`. It already carries `size`, and `materializeStagedFile`
already stats the source, so the embedder pays nothing new to produce it. The managed service, whose
inputs come from an object store, supplies the object's last-modified epoch — a value it already has.

The completed result records the structured triple, not a pre-joined string:

```ts
readonly inputFiles?: { fileId: string; size: number; mtimeMs: number }[];
```

**Rejected: overload `inputFileIds` with `"fileId:size:mtime"` strings.** The field's name and its
consumers (audit: *which* files did this profile cover) would then lie. Two fields, two questions.

**Optional, not required.** A row completed before this change has no `inputFiles`. Rather than
backfill (we cannot — the sizes and mtimes at profile time are gone), a reader treats its absence as
drift. That is exactly the rule the current code already applies to a completed row with a null
`result` ("a contract gap re-profiling heals", `profile_trigger.ts:193-196`), so the behavior is
consistent and self-healing: one re-profile on first open after upgrade, then steady state.

## D4. `CREATE TABLE` stops contradicting the migration

`initCortexState` currently declares `data_profile_status TEXT NOT NULL DEFAULT 'pending'`
(`init.ts:23`) and then, in the same call, runs `ALTER … DROP NOT NULL` (`init.ts:374`). Both fresh
and migrated databases end nullable, so this is a readability defect, not a behavior one — but
`loadDataProfileStatus`'s null-collapse contract depends on a nullable column, and line 23 tells a
reader the opposite.

The `NOT NULL` comes off the `CREATE TABLE`. The `ALTER` **stays**: databases created before this
change still carry the constraint, and `DROP NOT NULL` on an already-nullable column is a no-op. The
`DEFAULT 'pending'` also stays — a row inserted without an explicit status is a freshly-seeded
analysis awaiting its first profile, which is what `'pending'` means.

## D5. Test the invariant, not the code path that happens to reach it

The existing trigger test seeds `status = 'pending'`, which the pre-existing CAS branch claims. It
would pass with the NULL clause deleted. The replacement seeds the state that actually exercises the
clause:

| Row state | seed | expected | what it pins |
|-|-|-|-|
| `status = NULL` | non-empty | `started` | the `IS NULL` claim clause (was untested) |
| `status = 'pending'` | non-empty | `started` | the pre-existing claim clause |
| `status = NULL` | `NULL` | `failed`, row untouched | the seed conjunct |
| `status = NULL` | `[]` | `failed`, row untouched | D2 |
| `status = 'completed'` | non-empty | `restarted` | rerun claim keeps its seed conjunct |

The NULL-status-plus-seed row is the real production state — `clearDataProfile` nulls status, a later
`upsertAnalysis` repopulates the seed via `COALESCE` without touching status — so this is the
lifecycle the branch's fix was for, and it now has an end-to-end test through `triggerDataProfile`.
