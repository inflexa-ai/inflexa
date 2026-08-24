# Design — decision ledger

Decisions below are locked unless marked OPEN. Each carries its why and what was
rejected. Vocabulary first, because half the prior confusion was two people using one
word for two things.

All examples in this document are synthetic. Benchmark evidence lives in a private
workspace outside this repo; nothing here names or describes any real dataset.

## Vocabulary

| term | meaning | replaces |
|-|-|-|
| scanner | deterministic pre-pass over the input tree; observes, never assigns meaning | input scan |
| detected set ("set") | scanner-found menu item: files whose paths match one template | shape |
| slot | a varying hole in a set's path/name template, with token class, cardinality, bounded value sample | variable position |
| declared group ("group") | what the agent declares a set (or op result) of files to BE | kind |
| dimension | dataset-level thing that varies (subject, timepoint, assay version) | axis |
| observation | one evidenced sighting of a dimension (slot / column / document-or-mapping) | — |
| binding | naming a slot as a dimension ("slot A of S1 is the subject") — the only group↔dimension link | — |
| companion | helper file attached to a data file (.bai/.tbi/.md5); member = logical unit | — |
| quarantine | deterministic junk bucket (never reaches the menu) | — |

"Slot" is deliberately mechanical so it cannot be read as a design fact; "dimension" is
reserved for the dataset level. "Factor" was rejected: it implies deliberate
manipulation, wrong for observational cohorts.

## Groups (Topic 1)

- **Partition with repair, not overlay.** Every kept file lands in exactly one group.
  The submit validator hands unmatched files back to the live agent once; the residue
  auto-sweeps into a visible `unclassified` group. Rejected: hard rejection (one
  stubborn file blocks a profile that gates planning) and the status quo overlay
  (observed profiles under-covered silently). Membership is exclusive; "a file in two
  groups" is a dimension relationship, not dual membership.
- **Menu operations, not freehand patterns.** The agent expresses judgment as
  `use(set)`, `split(set, by slot | by value mapping)`, `merge(sets…)`,
  `group([paths])`. The system resolves membership; a typo'd value is a rejectable
  error at submit, not a silent zero-match. Rejected: freehand + validation (fixes
  correctness, not run-to-run drift — every run starts from the same menu under ops).
- **Membership is resolved at submit; patterns are display-only.** Persisted form is
  the ops recipe + derived counts + rendered template. Full member path lists are not
  persisted (thin-ledger; the live tree stays the file-list authority). Counts are
  always derived, never agent-declared.
- **Companions attach.** Scanner detects same-stem helper suffixes; "N data files,
  M indexed" becomes computed per-member completeness. Rejected: separate role=index
  groups (completeness would need cross-group correlation).
- **Per-file prose = member annotations.** No separate notable-files array: singletons
  are groups of count 1, and a group may carry an optional path→description map for
  members the agent read or deems notable — never required to be exhaustive.
  Annotated members feed the index.

## Scanner (Topic 2)

Pipeline: quarantine → markers → sibling-dir clustering → template mining → assembly.
Validated by prototype against a private corpus of real trees (results tracked outside
this repo).

- **Quarantine is rule-based and first**: gitignore-style OS/sync junk list + atomic-write temp
  idioms (`*.part`, `*.crdownload`, `*.tmp`, `.nfs*`) + the host's own `*.tmp-<uuid>`.
  Evidence class: partial-download twins observed absorbed into shapes.
- **Markers pre-empt inference** (ordered list; claims subtree): 10x MEX triplet,
  `meta_study.txt`, `dataset_description.json`. Small list now; catalogue additive.
- **Sibling-directory clustering** adapts AWS Glue's documented crawler rule
  (similarity ≈0.7, majority-rule template root); directory segments become slots.
  Content-schema similarity is a hook (needs header readouts). Evidence class:
  per-sample trees (`cohort/<subjectId>/<sampleId>/…`) are invisible to
  within-directory grouping.
- **Template mining** tokenizes the full name including dotted suffix chains (only
  terminal known data extensions are extensions). Opaque-ID token class: length ≥16,
  base64url charset, ≥3 mixed character classes (plus UUID/hex shapes); prototyping
  found case-transition density the decisive signal. Literal-vs-slot by per-position
  distinct counts (Drain-style); proliferation bounded MDL/knee, not only a hard cap.
- **Variance is carried, not split**: format/wrapper disagreement inside a set is a set
  property (evidence class: an entire slot value's members plaintext despite a `.gz`
  name must not split from their true-gzip siblings). Dir-token = stem-token is
  cross-checked and reported as one identity slot.
- **Menu entries are bounded regardless of cardinality**: token class + distinct count
  + bounded value sample (~5–20). Full value sets stay host-side for validation,
  completeness arithmetic (e.g. `samples × classes × callers = member count`),
  cross-set identity checks, and the index build. Slots persist in the profile (class,
  cardinality, samples); full value enumerations do not.
- **Readout budget**: one member header per set plus every leftover/singleton —
  leftovers are the files no set speaks for. (Within-set homogeneity confirmation via
  K>1 members was considered and deferred with the content-similarity hook.)
- **Category pre-suggestion only where near-certain** (a VCF set → variant-calls;
  `.md` → document); agent confirms or overrides. Rejected: aggressive suggestion
  (rubber-stamping) and none (loses free consistency).
- **All TypeScript**: string tokenization + hash-map grouping, sub-second at
  thousands of files; no npm dependency earned vendoring; Glue/Drain adopted as
  designs, not libraries.

## Dimensions (Topic 3)

- **Dimensions carry observations; evidence is structural.** An observation states
  where the dimension was seen and what was seen: slot observation (bound to a scanner
  slot — cardinality/values computed), column observation (file + column, agent read
  it), document/mapping observation (citation). A dimension cannot exist without an
  observation; an observation cannot exist without evidence. This generalizes the
  existing `organism` source+confidence pattern.
- **Groups link to dimensions only through slot bindings.** There is no freehand
  "group varies by X" field — the agent names slots, so a per-subject-cardinality
  dimension attached to a handful-of-files group is unwritable. Column observations
  are dataset-scoped by construction.
- **No single canonical cardinality.** Metadata may describe N subjects while files
  exist for M — both stand, per observation; the reconciliation note carries the
  delta and renderers show numbers side by side. Rejected: agent-designated headline
  number (a silent judgment every consumer would inherit).
- **Cross-source identity is measured where feasible**: overlap recorded ONLY as a
  performed measurement (`checked: {matched, of}`); the field is absent when unchecked.
  A boolean was rejected — `overlap: false` claims an exhaustive check that never
  happened.
- **Promotion rule**: naming a slot ≠ promoting a dimension. Technical, single-set
  slots (shards, callers, lanes, read pairs) stay on the set; the dataset-level
  dimension list is reserved for biological or cross-set variation — it must read as
  "the design at a glance".
- **Constants are not dimensions** (ISA: a factor varies). A tissue constant across
  the dataset is an identity fact and uses the existing identity fields.
- **Nesting is representable**: optional `nests under` between dimensions, evidenced
  by path structure (subject directories contain sample directories) or a mapping
  file's columns.
- **Probe list, not checklist.** A short shipped-as-data list of standard dimensions
  (subject, sample, condition/arm, timepoint, batch). For each, the agent returns
  found (with observations) or not-found (`searched: [files…]` + reason). "Not found
  after looking" is a correct, complete answer — this removes the completeness
  pressure that forces invented dimensions while keeping coverage of the standard
  ones. Self-reported; no tool-call-level enforcement (agent states reasons; that is
  the audit currency). Everything off the probe list is recorded only if encountered
  during normal orientation reading — no exhaustive column hunts.

### The substrate test (split vs dimension) — keep in docs and prompts

> **Would a downstream step typically consume one value's files as a different
> substrate than another's?** Yes → split the set into groups (somatic/germline,
> tumor/normal). No — the values are variants of the same substrate → keep it a
> slot, possibly bound to a dimension (caller, lane, read pair, chromosome shard,
> replicate). Identity slots (high-cardinality IDs) are never split.

("Typically", not "ever" — review found "ever" satisfiable for nearly anything, so
it cannot discriminate. Case/control is NOT a canonical split example: cohort-arm
defaults to dimension — comparative models consume all arms together — with split
reserved for independent cohorts as a stated deviation.)

Consequence analysis that produced it: splitting loses nothing and not-splitting loses
nothing structurally; what differs is the retrieval unit the index and orientation
present to the planner, execution agents, and talk-to-your-data. Consistency mechanism:
each vocabulary category carries a default treatment (split-worthy vs dimension-only);
the agent follows defaults and deviates only with a stated reason. Timepoint is the
known-ambiguous category: default dimension, documented.

## Persistence & projection (Topic 5)

- **Index tiers: groups + annotated members + dimensions.** Group entries (meaning,
  category, template, count), member entries only for files carrying agent-written
  annotations (kept under the existing `"input"` type so old filtered searches keep
  working), dimension entries with observation summaries. Rejected: no per-file tier
  (makes the observed searchability gap permanent) and indexing every member
  (floods the index with synthetic near-duplicates). Invariant kept: the index is a
  pure projection, rebuildable from tree + persisted profile — which makes re-indexing
  a REPLACE: the profile's own tiers are deleted before the rebuild, because an
  id-keyed upsert leaves a renamed group's entry behind forever. The delete surface is
  narrow by metadata type, so a writer cannot reach another tier's rows.
- **Orientation: census in header, structured before prose, prose double-capped.**
  The partition makes coverage a census, not a warning — it joins the header line
  (`N files in K groups · U unclassified · Q quarantined`) and can never be clamped
  out. Order: identity → census → groups → dimensions (side-by-side numbers) →
  design → concerns. Concerns get per-item AND total-share caps.
- **`qualityAssessment.strengths` is dropped.** Nothing renders or consumes it; it
  was pure token cost. `concerns` stays (planner-blocking facts earned their place);
  consider renaming to `caveats` — "quality assessment" is the QC framing the prompt
  forbids.
- **Drift signature digests kept files only.** Junk and partial-download artifacts
  appearing or vanishing never invalidate a profile; a quarantine-rule change
  recomputes signatures once on next scan.
- **Incremental absorption is in scope (design and implement here).** The persisted
  ops recipe re-resolves against a changed tree: new files matching existing set
  templates are absorbed deterministically (membership, counts, signature re-stamped —
  no LLM); only structurally new files wake the agent, and then as a repair-style
  round over the delta, not a blank-page re-profile. Rejected: defer to a follow-up
  (the recipe design is the same work either way) and full re-profile always (every
  added file would cost a full LLM pass).

## Implementation decisions (locked unless overturned in review)

- **Repair is full resubmit**: the agent replaces the whole ops list; no patch/merge.
- **Menu overflow**: rendered menu capped (~40 sets), tail folded into a counted
  "unlisted sets" line; `scan_inputs` re-scans are informational only — ops target
  top-level menu ids exclusively.
- **Recipes reference templates, not menu ids** (ids are per-scan ephemera;
  absorption re-resolves against fresh scans).
- **Absorption is a pre-step of the existing profile workflow**: claim row → attempt
  deterministic absorb → full absorb completes without sandbox/LLM; partial absorb
  proceeds to the agent with the delta. No new lifecycle.
- **Machine findings and agent caveats never mix**: computed facts (companion gaps,
  incomplete crossings, reconciliation deltas) live in structured fields; `caveats`
  is agent-authored only.
- **A contested file is swept, never awarded.** Overlapping operations stay a repair error
  while a repair round remains. On the LAST round there is nobody to hand the error to, so
  the file is removed from EVERY claimant and sweeps into `unclassified`, recorded as a
  machine finding (contested count + example paths) and in the monitoring event. Rejected:
  first-claimant precedence (the thing the partition exists to forbid, and it would have
  been invisible) and hard failure (one overlap blocks a profile that gates planning).
  The partition arithmetic therefore holds unconditionally, at every round.
- **The unclassified sweep is carried in the recipe as explicit paths**, bounded, deviating
  from the thin-ledger rule that membership is not persisted. Without it every replay
  re-derives the residue as unclaimed, so a byte-identical tree re-absorbs as PARTIAL and
  wakes the agent to re-judge files it already declined to judge — defeating the zero-delta
  case absorption exists for. Past the bound the step records a prefix and says so; that
  profile's replays wake the agent, which is the honest outcome for a sweep that large.
- **Dimension slot bindings are template-keyed, and recomputed on replay.** A slot
  observation persists `(pathTemplate, slot position)` alongside the display-only scan
  slot id; an absorb re-resolves the binding against the fresh scan and recomputes
  cardinality and values. Slot ids are per-scan ephemera — after a set-order flip the same
  id names a different slot, and carrying the observation verbatim would persist a stale
  cardinality under a slot it never measured. A binding that no longer resolves strands the
  recipe. Non-slot observations (column, document) are agent citations and still carry
  verbatim.
- **Two slots the scanner itself linked are never intersected.** `sameAsSlot` means the
  scan matched the two positions member by member and counted the disagreements. Affix
  recovery strips literal text off one side, so an exact value-set intersection over them
  reports `matched: 0` — a claim of total disjointness over a one-to-one correspondence.
  The observation carries the scanner's link and its mismatch count instead, and `checked`
  stays absent, because the value-set comparison was not a measurement worth performing.
- **Monitoring is one structured log event per completed profile**: counts of
  `other` usage, unclassified size, probe not-founds, repair rounds.
- **Vocabulary is package-owned and versioned with the harness; no host extension.**
- **Clean break on the wire**: writer emits `groups`/`dimensions` only; readers
  accept legacy `kinds`/`axes`; frontend follows via a contracts bump.
- **No schema version field** — optionality remains the compatibility mechanism.

## OPEN — pending decisions and curations

- **Vocabulary curation** (drafted as `vocabulary.md` in this change, under review):
  dimension categories with anti-overlap definitions and per-category default
  treatment; group role×category enum; probe list contents; usage instructions.
  Sources: Expression Atlas controlled vocabulary, SDRF/MIAME bio-vs-technical split,
  OMOP clinical dimensions, GDC/ENCODE/cBioPortal type enums.
- **Prototype hardening**: corpus-tuned thresholds need wider validation; trees of
  one-off human-named files remain partially covered by design (honest singletons);
  co-clustering of multiple marker-claimed units; render cap for re-uploads of prior
  run outputs.
- **Menu nudge**: `use`/`merge` of a `<rest>` catch-all set should prompt the agent to
  consider splitting it (catch-alls invite lazy merges — observed in walkthrough
  simulation).
