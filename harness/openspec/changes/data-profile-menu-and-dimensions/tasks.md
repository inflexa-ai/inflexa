# Tasks

Coarse until the OPEN decisions in design.md close; refine before implementation.

**Data hygiene rule for this change**: nothing derived from real analysis trees enters
this repo — no fixtures, benchmark outputs, example renders, tree shapes, counts, or
dataset-identifying names in code, tests, comments, or specs. Port code only from the
private benchmark workspace; synthetic fixtures are authored fresh here.

## 0. Remaining design (inline in this change)
- [x] Independent agent review passes (three blind reviewers, one per catalogue) — findings integrated into vocabulary.md v2
- [x] Pending vocabulary calls resolved (2026-08-24): cohort-arm defaults dimension; code is a category
- [x] Robert's red-pen pass on vocabulary.md v2 (2026-08-24)
- Deferred explorations (Robert, explicitly out of scope for this change):
  - Eager/mount-time profiling of shared drives — **considered and dropped 2026-08-24**: the deterministic scan is near-free and cacheable by input signature, and incremental absorption already covers the same-files-new-analysis case (zero-delta re-resolution), so mount-time machinery buys consistency we get anyway.
  - [ ] Align post-step execution file indexing with the data-profile model — **explored 2026-08-24, feasible as a follow-up change** once the scanner lands as a pure library. Today's output path is strictly flat: the metadata agent is prompted with every output path in one message, one embed + one index row per file, no grouping and no cap; budget exhaustion silently degrades the remainder to fallback text. Follow-up shape: run the scanner over the reconciled step manifest (paths/sizes/hashes already in hand — no extra walk), have the metadata agent describe detected sets + notable members instead of every file, index set entries + annotated member entries, and update the one consumer invariant (workspace_search documents "entry id IS the workspace path" for outputs) plus its prompt guidance. Artifact registration is unaffected (the manifest carries no descriptions). Notes from review: agents typically write outputs flat into `output/` with no subdirs — fine, because name-template mining works within a single directory and loop-generated names are mechanically consistent; sibling-dir clustering is just a bonus when subdirs exist. Comb the sandbox prompts for layout anti-patterns and add light guidance (consistent name pattern or per-entity subdir for many-per-entity outputs; no non-result droppings in `output/`) — outputs are the one tree where we control both producer and scanner. Feed the metadata pass the scan menu + the step summary so producer knowledge attaches at set level. Deeper option, same change: bind output-set slots to existing profile dimensions when values overlap.
- [x] Delta specs under `specs/` (input-scan-manifest, data-profile-init, data-profile-rerun, sandbox-format-standards) — written against the post-`data-profile-orientation` spec state; archive that change first

## 1. Scanner
- [ ] Port the prototype pipeline into `input-scan/` (quarantine, markers, sibling clustering, mining, assembly); adopt the prototype's integration notes (path templates, slots, format census, cross-checks) — code only, per the hygiene rule
- [ ] Companion detection (same-stem helper suffixes) + per-member completeness
- [ ] Readout budget: one member per set + all leftovers/singletons; content-similarity hook
- [ ] Threshold validation on synthetic suites; date-token class; marker-unit co-clustering
- [ ] Move prefix-sufficient decoding (CSV sniff, gzip peek, text headers) to TS over the workspace read seam; residual parquet/HDF5 decoder as linted+pytested `.py` asset; delete the `String.raw` blob

## 2. Authoring contract
- [x] Vocabulary as data (`contracts/profile-vocabulary.ts`): group roles, group categories with anti-overlap notes, dimension categories with default treatment, probe list — one source for submit validation and prompt assembly
- [x] Menu render into the profiler briefing (bounded; nudge on catch-all use/merge)
- [x] `submit_profile` ops vocabulary (use/split/merge/group) + submit-time resolution: membership, derived counts, partition check, one repair round-trip, `unclassified` sweep
- [x] Dimensions/observations schema (slot bindings, column/document evidence, `checked:{matched,of}`, nests-under, probe outcomes); member annotations on groups; drop `qualityAssessment.strengths`; renames kinds→groups, axes→dimensions with legacy optional-on-read
- [ ] Prompt rewrite: substrate test verbatim, probe list, no-forcing stance ("empty is a correct answer"), category defaults
- [ ] Incremental absorption: recipe re-resolution against a changed tree; deterministic absorb path (membership/counts/signature, no LLM); delta repair round for structurally new files; drift digest over kept files only

## 3. Projection & consumers
- [ ] Index: groups + member annotations + dimensions entries (restore per-file searchability)
- [ ] Orientation: new field order, coverage/integrity signals survive the clamp
- [ ] `inspect_data_profile` over the new record; contracts for the frontend

## 4. Verification
- [ ] Synthetic fixture suites per pipeline stage (authored in-repo, no real-tree derivation)
- [ ] Ops-resolution property tests (every file accounted; partition invariant)
- [ ] Host-side end-to-end validation against real trees stays in the private workspace; only pass/fail conclusions recorded here

## Companion items (not this change)
- [ ] Host ticket: input materializer leaves sparse `*.tmp-<uuid>` partial downloads beside completed twins
- [ ] Optional hotfix change on the current minor: brace matching, per-file index drop, orientation ordering
