## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Structurally familiar new files are absorbed without a model

The persisted operations recipe SHALL be keyed to scanner templates, never to menu
identifiers — menu identifiers are per-scan ephemera, and a recipe addressing them could
not be replayed against a fresh scan.

Absorption SHALL run as a pre-step of the existing profile workflow, introducing no new
lifecycle: the body claims the row, re-scans, and re-resolves the recipe against the
fresh scan. Files matching existing templates are absorbed deterministically — membership,
derived counts, and the input signature are re-stamped with no sandbox and no LLM call —
and a full absorb completes the profile there. Files matching no template proceed to the
agent as a repair-style round over the **delta only**, with the resolved recipe carried
forward; a drift event SHALL NOT cost a blank-page re-profile when the tree's structure
is already described.

A recipe that no longer resolves — a scanner change or a reshaped tree strands its
templates — SHALL fall back to a full re-profile, never to a silent partial absorb.

#### Scenario: Template-matching files absorb deterministically

- **GIVEN** a completed profile whose recipe covers a per-sample template
- **WHEN** files for additional samples matching that template are staged
- **THEN** the pre-step SHALL absorb them into the existing groups, re-derive counts, re-stamp the signature, and complete without a model call

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
