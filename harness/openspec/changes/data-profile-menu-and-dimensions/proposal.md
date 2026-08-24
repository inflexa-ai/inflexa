# Menu-driven data profile: detected sets, declared groups, dimensions

## Why

The `data-profile-orientation` change replaced per-file agent profiling with a
deterministic scan plus agent-authored kinds/axes. Field experience with that shape
shows the authoring half fails in ways the scan half cannot repair:

- **Agent-typed patterns silently match nothing.** `compilePattern` treats `{a,b}` as
  literals; models write brace alternation constantly. Every recently inspected
  profile under-covered its tree, and the only signal is a `profile kinds do not cover
  the scanned tree` warning logged after the agent is gone — nothing repairs it.
- **Grouping is unanchored, so it does not reproduce.** Re-profiling the same small
  tree produces different kind counts and boundaries each run, and axis labels drift
  between synonymous phrasings. Groupings that start from a blank page cannot agree.
- **The scan fails the tree class it was built for.** On a large per-sample delivery —
  shape `cohort/<subjectId>/<sampleId>/<sampleId>__calls.<class>.<caller>.vcf.gz` at
  thousands of files — `observeShapes` leaves the overwhelming majority of files
  unstructured: shapes cannot cross directories (identity lives in directory
  segments), long base64url identity tokens defeat digit-run masking, the categorical
  suffix chain is treated as file extension, and the host's own `*.tmp-<uuid>`
  partial-download artifacts are absorbed into shapes.
- **Axes conflate file-level and row-level variation.** Observed profiles attach a
  per-subject-cardinality axis to a group of a handful of fixed tables — the subjects
  are *rows in columns*, not files — and nothing validates that a kind's axes are
  achievable given its member count.
- **Declared counts are trusted, not derived.** Kinds declare counts their own
  patterns do not match.
- **The index silently dropped per-file entries.** With kinds present,
  `data-profile-index` indexes kinds + entities only; the per-file descriptions the
  profiler paid tokens for become unsearchable.

A prototype of the redesigned scanner (private benchmark workspace, kept out of this
repo) was validated against a corpus of real trees spanning single-file uploads to
multi-thousand-file per-sample deliveries: well above 95% weighted set coverage, with
the motivating tree class fully covered — one cross-directory set with subject/sample
directory slots and categorical name slots enumerated, temp artifacts quarantined —
at sub-200 ms for thousands of files, in pure TypeScript.

## What Changes

- **Scanner becomes a five-stage pipeline** (pure over path/size/format):
  quarantine (gitignore-style junk + atomic-write temp idioms + `*.tmp-<uuid>`) →
  name-based markers (10x MEX triplet, `meta_study.txt`, `dataset_description.json`;
  a marker claims its subtree) → sibling-directory clustering (Glue-style: name-template
  + format agreement, ~0.7 similarity, majority root; content-schema hook for later) →
  full-name template mining (dotted suffix chains groupable; opaque-ID token class;
  Drain-style positional literal-vs-variable; MDL-bounded proliferation) → variance
  carried, not split (wrapper disagreement is a set property; dir-token = stem-token
  cross-checked as one identity slot).
- **The agent authors groups by operating on a menu, never by typing patterns.**
  The scanner presents detected sets; the agent submits `use` / `split` (by slot or by
  value mapping) / `merge` / `group` (explicit paths). Membership, counts, and coverage
  are computed at submit; pattern text becomes display-only.
- **Coverage is a partition.** Every kept file lands in exactly one group; unmatched
  files go back to the live agent once for repair, then auto-sweep into a visible
  `unclassified` bucket. Companion files (`.bai`/`.tbi`/`.md5`) attach to their data
  file; a member is a logical unit and per-member completeness is computed.
- **Axes are replaced by dimensions with corroborating observations.** A dimension
  (subject, timepoint, assay version) carries a closed category + free label and one or
  more evidenced observations: slot observations (bound to scanner slots — cardinality
  and values computed; the only way a group links to a dimension) and column/document
  observations (agent-declared with mandatory citation). Disagreement between
  observations is recorded as reconciliation, not resolved to a single number. Optional
  `nests under` relations (subject → sample), evidenced by path structure or mapping
  files.
- **A curated vocabulary ships as data**: dimension categories for
  bio/bioinformatics/pharma/clinical with anti-overlap definitions, per-category default
  treatment (split-worthy vs dimension-only) governed by the substrate test (see
  design), a small probe list (subject, sample, condition/arm, timepoint, batch) with
  found / not-found-after-looking outcomes, and group role×category typing with
  scanner pre-suggestion only where near-certain.
- **The sandbox decoder shrinks and becomes real code.** Prefix-sufficient decoding
  (CSV sniff, gzip peek, text headers) moves to harness TS over the workspace read seam;
  the residual binary decoders (parquet, HDF5) become a linted, pytest-covered `.py`
  package asset — the `String.raw` Python blob in `enrich.js` is deleted.
- **Schema renames with legacy read compatibility**: `kinds` → `groups`,
  `axes` → `dimensions`; readers keep accepting old snapshots (optional-on-read is the
  existing compatibility mechanism).
- **Index and orientation follow the new model**: three index tiers (groups,
  annotated members under the legacy `"input"` type, dimensions); orientation puts the
  file census in its header and structured sections before double-capped prose;
  `qualityAssessment.strengths` is dropped.
- **Drift becomes precise and cheap.** The signature digests kept files only (junk
  never invalidates a profile), and the persisted ops recipe supports incremental
  absorption: new files matching existing templates are absorbed deterministically
  with no LLM call; only structurally new files wake the agent, over the delta.

## Out of scope

- The deterministic quick fixes on the current shape (brace matching, index drop,
  orientation ordering) — worth a separate fast change if the current minor line needs
  patching before this lands.
- Archetype catalogue growth beyond the initial marker list (mechanism ships here;
  vendor-delivery detection is additive later).
- The host-side input-materializer bug that leaves sparse `*.tmp-<uuid>` partial
  downloads beside completed twins — host ticket, not harness.
- Anything outside the data-profile capability.

## Impact

- Capabilities: `input-scan-manifest` (pipeline, quarantine, markers, cross-directory
  sets, decoder split), `data-profile-init` (authoring contract, partition, dimensions,
  vocabulary, index tiers, orientation, persistence), `data-profile-rerun` (kept-only
  signature, incremental absorption), `sandbox-format-standards` (profiler prompt).
- Consumers: planner briefings, workspace semantic search, inspect_data_profile,
  frontend profile rendering (wire shape via contracts).
- Ordering: this change modifies requirements introduced by `data-profile-orientation`,
  so that change must be archived first.
