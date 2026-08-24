# data-profile-rerun Specification

## Purpose

Define re-profiling — recomputing an analysis's data profile after its input set
changes (new files appended) — and clearance — removing the profile when the input
set empties, so consumers return honestly to "not profiled". Re-profiling is driven
by an atomic `completed → running` claim on the `data_profile_status` ledger so
concurrent re-profile triggers dedup: only one CAS UPDATE wins and starts a workflow.
Every claim into `running` also requires a non-empty seeded input set, so a running
profile always names the inputs it is profiling. The prior `data_profile_result` is
deliberately preserved during the re-profile so the API can keep serving the last
profile while the new one runs. The result snapshot records which inputs were
profiled (`inputFileIds`), their per-file drift signatures (`inputFiles`), and when
(`profiledAt`) — so both staleness (files added since the last profile) and drift (an
in-place edit of an already-profiled file) are detectable against the current
staged-input manifest.
## Requirements
### Requirement: A running profile always names a non-empty seeded input set

Every ledger transition into `'running'` SHALL claim a row only when `seed_input_file_ids` is a
non-empty JSON array. This applies to `tryStartDataProfile`, `tryRerunDataProfile`, and
`tryRetryDataProfile` alike.
The predicate SHALL live in the CAS `UPDATE ... WHERE` clause, so that "a `running` row records the
input set it is profiling" is an invariant of the ledger rather than a property of any one caller's
read-then-write sequence. A NULL seed and an empty (`[]`) seed SHALL be treated identically as
"unseeded".

A caller MAY additionally pre-read the seed column to produce a precise operator message, but such a
pre-read SHALL NOT be the enforcement: between a pre-read and a claim, `clearDataProfile` can null the
seed of any non-`running` row, so a claim guarded only by a pre-read can create a `running` row with
no recorded input set.

#### Scenario: A NULL seed refuses the start claim

- **WHEN** `tryStartDataProfile(querier, analysisId)` is called for a row whose `data_profile_status` is `'pending'` and whose `seed_input_file_ids` is NULL
- **THEN** it SHALL resolve to `ok(false)`
- **AND** `data_profile_status` SHALL remain `'pending'`

#### Scenario: An empty seed array refuses the start claim

- **WHEN** `tryStartDataProfile(querier, analysisId)` is called for a row whose `seed_input_file_ids` is `[]`
- **THEN** it SHALL resolve to `ok(false)`
- **AND** the row SHALL be untouched

#### Scenario: A clear racing a claim cannot produce a seedless running row

- **WHEN** `clearDataProfile` nulls a row's status and seed after a caller's seed pre-read observed a non-empty seed, and that caller then invokes `tryStartDataProfile`
- **THEN** the claim SHALL resolve to `ok(false)`
- **AND** no row SHALL exist with `data_profile_status = 'running'` and a NULL or empty `seed_input_file_ids`

#### Scenario: The rerun and retry claims carry the same conjunct

- **WHEN** `tryRerunDataProfile` is called for a `'completed'` row, or `tryRetryDataProfile` for a `'failed'` row, and in either case `seed_input_file_ids` is NULL or `[]`
- **THEN** the claim SHALL resolve to `ok(false)` and the row SHALL be untouched

### Requirement: The trigger rejects an unseeded analysis before dispatch

`triggerDataProfile` SHALL return `"failed"` without attempting a claim when the analysis's
`seed_input_file_ids` is NULL or empty, and SHALL log the rejection naming the analysis. This
pre-check is the source of the operator-facing reason; the CAS conjunct of the preceding requirement
is the enforcement.

#### Scenario: An unseeded analysis is refused before any claim

- **WHEN** `triggerDataProfile` runs for an analysis whose `seed_input_file_ids` is NULL
- **THEN** it SHALL return `"failed"`
- **AND** the ledger row SHALL be untouched (no transition to `'running'` is attempted)

#### Scenario: An analysis seeded with an empty set is refused

- **WHEN** `triggerDataProfile` runs for an analysis whose `seed_input_file_ids` is `[]`
- **THEN** it SHALL return `"failed"` and the ledger row SHALL be untouched

### Requirement: Atomic completed → running re-profile transition

`tryRerunDataProfile(querier, analysisId)` SHALL atomically transition `data_profile_status` from
`'completed'` to `'running'` with a single `UPDATE ... WHERE data_profile_status = 'completed' AND
seed_input_file_ids IS NOT NULL AND jsonb_array_length(seed_input_file_ids) > 0`. It SHALL set
`data_profile_started_at` to the current timestamp and clear `data_profile_error` and
`data_profile_completed_at`. It SHALL NOT clear `data_profile_result` — the prior profile is preserved
so the API can serve it during the re-profile. It SHALL resolve to `ok(true)` when the CAS won and
`ok(false)` when it lost or the row was unseeded; neither losing the race nor an unseeded row is an
error, both stay in the ok channel.

#### Scenario: Completed profile transitions to running

- **WHEN** `tryRerunDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'` and a non-empty `seed_input_file_ids`
- **THEN** it SHALL resolve to `ok(true)`
- **AND** `data_profile_status` SHALL be `'running'`
- **AND** `data_profile_started_at` SHALL be updated
- **AND** `data_profile_error` and `data_profile_completed_at` SHALL be NULL
- **AND** `data_profile_result` SHALL retain its prior value

#### Scenario: Race condition — two concurrent re-profile triggers

- **WHEN** two callers invoke `tryRerunDataProfile()` concurrently for the same analysis
- **THEN** exactly one SHALL resolve to `ok(true)`
- **AND** the other SHALL resolve to `ok(false)`

#### Scenario: Non-completed status is a no-op

- **WHEN** `tryRerunDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'running'`
- **THEN** it SHALL resolve to `ok(false)`
- **AND** the status SHALL remain `'running'`

### Requirement: Result snapshot carries the profiled input set

The `data_profile_result` JSONB stored by `completeDataProfile` SHALL carry, in addition
to the resolved profile (see the data-profile-init spec):

- `inputSignature: { count: number; digest: string }` — the comparand identifying *which*
  files a profile covered and *whether the same bytes* were profiled. `count` is the
  number of **kept** staged inputs; `digest` is a stable hash over the kept inputs'
  identities and their per-file size and mtime, computed in a canonical order so the
  value depends on the set and not on enumeration order.
- `profiledAt: string` — ISO 8601 timestamp of profile completion

The signature SHALL digest **kept files only**. Quarantined junk and partial-download
artifacts appearing, changing, or vanishing SHALL NOT invalidate a profile: a temp file
is not part of what was profiled, so its churn is not drift. A change to the quarantine
rules themselves recomputes signatures once on the next scan, which is the correct
consequence — the definition of "kept" changed.

A consumer SHALL detect drift by computing the same signature — quarantine applied first —
over a freshly enumerated input set at stat cost and comparing it against
`inputSignature`.

`inputFileIds: string[]` and `inputFiles: { fileId, size, mtimeMs }[]` SHALL remain
readable and SHALL be optional on read, with the existing fallback semantics: a snapshot
carrying neither a signature nor an id list is drift, and re-profiling heals it.

The signature deliberately excludes the content hash: enumerating it would require
reading every input in full on every parity check. An edit that preserves both byte
length and mtime is therefore not detected — a bounded, documented limitation.

#### Scenario: Junk churn is not drift

- **GIVEN** a completed profile carrying an input signature
- **WHEN** a partial-download temp file appears beside the staged inputs and the signature is recomputed
- **THEN** the digests SHALL be equal and the profile SHALL NOT be reported stale

#### Scenario: A changed kept set is detected

- **GIVEN** a completed profile carrying an input signature
- **WHEN** a data file is added to the analysis and the signature is recomputed
- **THEN** the digests SHALL differ and the profile SHALL be reported stale

#### Scenario: The signature is order-independent

- **GIVEN** two enumerations of the same kept input set differing only in order
- **WHEN** the signature is computed over each
- **THEN** the two digests SHALL be equal

#### Scenario: A legacy snapshot still compares

- **GIVEN** a snapshot written before `inputSignature` existed, carrying `inputFileIds`
- **WHEN** a consumer evaluates staleness
- **THEN** it SHALL fall back to comparing the identity list rather than treating the snapshot as drift

### Requirement: Profile clearance when the input set empties

`clearDataProfile(querier, analysisId)` SHALL null the profile ledger columns
(`data_profile_status`, `data_profile_error`, `data_profile_started_at`,
`data_profile_completed_at`, `data_profile_result`, `seed_input_file_ids`) with a
single UPDATE guarded by `data_profile_status IS DISTINCT FROM 'running'` — a live
workflow's completion write would resurrect half-cleared state, so a running profile
is never cleared and the caller re-evaluates parity after that run completes. It
SHALL resolve to `ok(true)` when a row was cleared and `ok(false)` when nothing was
(the profile is running, or no analysis-state row exists) — skipping stays in the ok
channel, not the error channel. `data_profile_status` SHALL be nullable: a NULL
status means "no profile", and `loadDataProfileStatus` SHALL return `null` for it —
deliberately indistinguishable from the analysis-state row never having existed, so
consumers have exactly one "not profiled" state.

A NULL-status row SHALL be claimable by the start transition — `tryStartDataProfile` claims the
startable states (`'pending'` or NULL) into `running` — because the seed upsert's conflict branch
deliberately never rewrites profile status, so without this claim an analysis whose inputs return
after a clear could never be profiled again by any path. That claim SHALL nonetheless remain subject
to the seed conjunct: because `clearDataProfile` nulls the seed alongside the status, a cleared row
becomes claimable only once a later seed upsert has repopulated `seed_input_file_ids`.

#### Scenario: Clearing a completed profile

- **WHEN** `clearDataProfile(querier, analysisId)` is called for an analysis with `data_profile_status = 'completed'`
- **THEN** it resolves to `ok(true)`
- **AND** all six profile columns SHALL be NULL
- **AND** `loadDataProfileStatus` SHALL subsequently resolve to `null`

#### Scenario: A running profile is never cleared

- **WHEN** `clearDataProfile(querier, analysisId)` is called while `data_profile_status = 'running'`
- **THEN** it resolves to `ok(false)`
- **AND** every profile column SHALL retain its prior value

#### Scenario: Clearing without an analysis-state row

- **WHEN** `clearDataProfile(querier, analysisId)` is called for an analysis with no `cortex_analysis_state` row
- **THEN** it resolves to `ok(false)`

#### Scenario: A cleared row is not claimable until it is reseeded

- **WHEN** `tryStartDataProfile` is called for a row `clearDataProfile` just nulled, before any seed upsert has run
- **THEN** it SHALL resolve to `ok(false)` (the status is claimable, the seed is not)

#### Scenario: A cleared-then-reseeded row is claimable

- **WHEN** a seed upsert repopulates `seed_input_file_ids` on a NULL-status row and `tryStartDataProfile` is then called
- **THEN** it SHALL resolve to `ok(true)` and `data_profile_status` SHALL be `'running'`

### Requirement: A profile that covered little of its input set is not reported as fresh

The result snapshot SHALL carry the partition accounting — kept files, per-group counts,
the `unclassified` count, and the quarantined count — and `inspect_data_profile` SHALL
surface it.

Under the partition (see the data-profile-init spec) a profile cannot silently cover
little: every kept file is in a group, and what the old coverage figure measured survives
as the size of `unclassified`. A large `unclassified` group is a visible fact about the
profile, not a hidden shortfall.

The `unclassified` size SHALL NOT by itself drive an automatic re-profile. Some input
sets legitimately resist classification, and a predicate that re-triggered on it would
re-profile them on every parity check.

#### Scenario: The accounting is readable

- **GIVEN** a completed profile whose resolution swept files into `unclassified`
- **WHEN** a consumer reads the profile
- **THEN** it SHALL be able to establish the kept, per-group, unclassified, and quarantined figures from the snapshot

#### Scenario: A large unclassified group does not loop

- **GIVEN** a completed profile with a large `unclassified` group and an unchanged input set
- **WHEN** the embedder applies the profiling policy
- **THEN** it SHALL NOT re-trigger profiling on the unclassified size alone

### Requirement: Structurally familiar new files are absorbed without a model

The persisted operations recipe SHALL be keyed to scanner templates, never to menu
identifiers — menu identifiers are per-scan ephemera, and a recipe addressing them could
not be replayed against a fresh scan. A dimension's slot observation SHALL be keyed the
same way, as the addressed set's template plus the slot's position within it: the scan's
own slot identifier is display-only past the scan that minted it, because a re-scan that
reorders the sets makes the same identifier name a different slot.

Absorption SHALL run as a pre-step of the existing profile workflow, introducing no new
lifecycle: the body claims the row, re-scans, and re-resolves the recipe against the
fresh scan. Files matching existing templates are absorbed deterministically — membership,
derived counts, and the input signature are re-stamped with no sandbox and no LLM call —
and a full absorb completes the profile there. Each dimension's slot observations SHALL be
re-resolved through their bindings and their cardinality and values RECOMPUTED against the
fresh scan; the labels, descriptions, reconciliations, and non-slot observations are the
profile's existing finding and are carried verbatim. Files matching no template proceed to
the agent as a repair-style round over the **delta only**, with the resolved recipe carried
forward; a drift event SHALL NOT cost a blank-page re-profile when the tree's structure
is already described.

The recipe SHALL also record the paths the previous resolution swept into `unclassified`.
A file that profile already declined to classify is NOT structurally new: on replay it
re-sweeps deterministically, a swept file that has since been deleted simply drops, and
only a file that is new to the tree and matched by no template is delta. Without that
record an unchanged tree re-absorbs as a partial and wakes the agent to re-judge what it
already judged. The record is bounded; a sweep past the bound records a prefix and says
so, and its replays wake the agent.

A recipe that no longer resolves SHALL fall back to a full re-profile, never to a silent
partial absorb. It no longer resolves when a scanner change or a reshaped tree strands its
templates, when a dimension's slot binding does not re-resolve, or when any step of it
produces no group — a step that resolved to nothing has deleted a group, renumbered its
siblings, and left every reference to it dangling.

#### Scenario: Template-matching files absorb deterministically

- **GIVEN** a completed profile whose recipe covers a per-sample template
- **WHEN** files for additional samples matching that template are staged
- **THEN** the pre-step SHALL absorb them into the existing groups, re-derive counts, re-stamp the signature, and complete without a model call

#### Scenario: An unchanged tree costs no model call, residue included

- **GIVEN** a completed profile that swept some files into `unclassified`
- **WHEN** the profile re-runs against a byte-identical tree
- **THEN** the pre-step SHALL report a full absorb and complete without a model call
- **AND** the previously swept files SHALL re-form the `unclassified` group rather than counting as delta

#### Scenario: A dimension's slot binding survives a re-scan that reorders the sets

- **GIVEN** a completed profile whose dimension binds a slot of one set
- **WHEN** files are staged that make another set outrank it, so the scan's slot identifiers name different slots
- **THEN** the absorbed profile's observation SHALL bind the same template slot
- **AND** its cardinality and values SHALL be recomputed from the fresh scan

#### Scenario: Novel structure wakes the agent over the delta

- **GIVEN** a completed profile and newly staged files matching no recipe template
- **WHEN** the profile re-runs
- **THEN** the agent SHALL be presented the unresolved delta alongside the carried-forward resolution
- **AND** SHALL NOT be asked to re-author groups the recipe already resolves

#### Scenario: A stranded recipe falls back loudly

- **GIVEN** a recipe whose templates no longer resolve against the fresh scan
- **WHEN** the pre-step runs
- **THEN** it SHALL proceed as a full re-profile
- **AND** SHALL NOT complete an absorb that silently dropped part of the recipe

#### Scenario: A step that resolves to no group strands rather than deleting it

- **GIVEN** a recipe whose explicit path grouping names files that have all been deleted
- **WHEN** the pre-step runs
- **THEN** it SHALL report the recipe stranded, naming the step
- **AND** SHALL NOT report a full absorb over a profile that lost a group

