## Context

A target assessment runs ~14 Phase-1 collectors in parallel. Each collector's output is
assembled into its own dossier section, and the sections are never cross-referenced. Two
per-organ shapes already exist:

- `safety_profile.organ_rollup` — a fold over the Phase-3 fan-out, whose `signals` field is a
  closed struct: `{chembl_polypharm_count, faers_count, trial_ae_count, class_liability_present}`.
  A source outside those four has no field to occupy.
- `safety_profile.regulatory_organ_signals` — per-organ FDA label warnings, already canonical
  and already carrying a regulatory locator.

The canonical organ vocabulary (`src/contracts/organ-system.ts`) makes the join possible:
per-organ evidence is joined by equality on the token, and producers resolve external names at
their own boundary.

## Goals / Non-Goals

**Goals:**

- Assert, per canonical organ, which independent sources carry a safety signal for it, with the
  evidence from each.
- Keep the contributing-source list open: adding a source must not touch the section's schema
  or the fold's contract.
- Satisfy the claim contract and the coverage envelope without a second, narrower evidence path.
- Add human phenotype evidence (Monarch) that the existing mouse-KO and Open Targets collectors
  do not carry.

**Non-Goals:**

- Replacing or removing `organ_rollup`. The spine does not re-derive its counters, and this
  change does not migrate its consumers.
- Re-fetching anything. Every signal the spine folds is already in hand when the fold runs.
- Scoring or ranking organs. The spine reports agreement; risk levels remain `organ_rollup`'s.
- A Human Protein Atlas client. HPA tissue expression already reaches the dossier (see below).

## Decisions

### The contributing sources are a set of records, not a struct

The section's row shape is:

```
{ organ, contributions: [{source, signal, evidence}], corroborating_sources, independent_source_count, support }
```

`contributions` is an array of records each naming its own source by a string id. Adding a
fifteenth collector means emitting `{source: "…", signal: "…", evidence: {…}}` — no new field,
no new branch, no consumer edit.

*Alternative considered: one optional field per source* (the `organ_rollup` shape). Rejected:
it forces a schema change per source, and — because a new source arriving before its field
exists has nowhere to go — it invites a second, narrower evidence path that then drifts from
the first. The closed struct is the reason this capability does not already exist.

*Alternative considered: a `Record<sourceId, contribution>` map.* Rejected: a map cannot hold
two signals from one source for one organ (three label warnings for `hepatic`), and JSON object
key order is not a reliable ordering for a rendered list. The array keeps both.

### Sources are registered as extractors over what already arrived

The fold takes one input bundle and applies a `SIGNAL_SOURCES` array of
`{id, extract(input) => OrganSignal[]}` entries. Registration is the whole integration surface:
a source appears in the fold by adding an entry, and its records flow through grouping,
counting, thresholding, and evidence assembly unchanged. The source id in `SIGNAL_SOURCES` is
the same string that lands in `contribution.source`, so the schema needs no source enum.

### Every contribution carries a locator, so every emitted row is scored

`ClaimEvidenceSchema` requires a locator; the contribution shape uses it directly. A signal
whose source cannot produce a locator is not admitted — it is discarded and counted, exactly
like a signal whose organ does not resolve. The consequence is that the spine only ever
constructs the `scored` branch of `ClaimSupport`: the `unknown` branch is unreachable here
*because* an unevidenced signal never becomes a row. This is the claim contract's invariant
holding structurally rather than by a runtime check, and it is why the spine needs no second
evidence path — the evidence is the contributions.

### The corroboration threshold is what `filtered` reports

An organ needs signals from at least `MIN_INDEPENDENT_SOURCES` (2) distinct source ids to
become a row; one source is the single-source artefact the spine exists to distinguish. Signals
discarded for that reason — plus signals whose organ or locator did not resolve — are counted
into `dropped_count`. When the count is non-zero and no row survives, the section reports
`coverage: "filtered"` with that count and the filter that ran. When rows survive but signals
were still discarded, `dropped_count` rides on the `available` branch, so a partial section does
not overstate its completeness. `dropped_count` counts *signals* — the fold's input unit —
which the section's own documentation states.

### The fold runs in Phase 5

Phase 5 is the first point where all the spine's inputs exist together: the Phase-1 collector
bundle (via `phase2.phase1`) and the FDA label organ signals segmented at the approval-precedent
step. Phase 4 stamps a `not_loaded` placeholder, exactly as it does for
`safety_profile.target_organ_liabilities`.

### Monarch is a new collector; the Human Protein Atlas is not

**HPA already flows in.** `collectExpressionHuman` calls Open Targets' baseline expression,
which is HPA consensus data — the collector labels it `source: "hpa_consensus"`, unit
`consensus_normalized`, and it feeds both `reference_biology.normal_tissue_expression` and the
off-tissue risk path. A dedicated HPA client would be a second wire to the same data. The spine
extends the existing path instead: a source extractor reads the expression collector's tissues,
applies the same safety-relevance and TPM-floor rules the off-tissue path applies, and resolves
tissue anatomy onto the canonical organ vocabulary with the same resolver.

**Monarch adds what IMPC and Open Targets do not.** IMPC carries *mouse* knockout phenotypes
(MP terms, viability). Open Targets carries an aggregate gene→disease association score
dominated by GWAS, literature, and known drugs. Monarch carries curated *human* gene→phenotype
(HPO, from HPOA/OMIM/Orphanet) and *causal* gene→disease (MONDO) associations — human
loss-of-function evidence, keyed to an ontology whose ancestor closure resolves cleanly onto
organ systems. Monarch's own gene→phenotype edges include mouse-model-derived rows; the
collector keeps only rows whose subject taxon is human, so the mouse channel stays IMPC's.

### Organ resolution uses ontology closure, not string matching

Monarch returns each phenotype's HPO ancestor closure. The resolver checks membership of the
HPO organ-system ancestor ids in that closure, most specific first. This is equality on
identifiers, not prose matching, and it fails closed: an HPO term under no known organ-system
ancestor is discarded and counted at the collector's own boundary.

## Risks / Trade-offs

- *A threshold of 2 hides a genuine single-source liability.* → The spine is additive: the
  single-source signal still reaches its own section (`regulatory_organ_signals`,
  `ko_phenotype`, `organ_rollup`). The spine only claims corroboration, and it reports the
  count of what it discarded so the omission is visible.
- *Two sources can be correlated rather than independent* — HPO annotations and Open Targets
  genetics can both trace to OMIM. → `independent_source_count` counts distinct *source ids*,
  and each contribution carries its own locator, so a reader can see the underlying records
  rather than trusting the count alone. The field is named for what it measures.
- *Monarch adds a fifteenth external dependency and a failure mode.* → It is a Phase-1
  collector, so a failure degrades that source's coverage envelope and the run continues with
  one fewer contributing source.
- *`organ_rollup` and the spine can disagree about an organ.* → They answer different
  questions: `organ_rollup` scores risk from fan-out counters, the spine reports cross-source
  agreement. Neither derives from the other, and the spine names its sources so a disagreement
  is inspectable rather than mysterious.
