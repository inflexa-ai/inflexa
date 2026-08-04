## Why

Phase 1 of a target assessment queries a dozen-plus independent sources, and every one of
them lands in its own dossier section. Nothing ever asks the question that separates a real
organ liability from a single-source artefact: *do these sources agree?* A hepatic warning on
an FDA label, a hepatic phenotype in a mouse knockout, and a human Mendelian hepatic phenotype
are three independent observations of one liability — today a reader has to notice that by
eye, across three sections, and the dossier records no claim about it.

The existing per-organ fold (`safety_profile.organ_rollup`) cannot answer it either: its
`signals` field is a closed struct with one counter per source, so a source that is not one of
those four has nowhere to land, and adding one is a schema change every consumer reads.

## What Changes

- Add a per-organ **evidence spine**: a fold that gathers every organ-bearing safety signal a
  run produced, groups it by canonical organ, and asserts corroboration — which sources agree,
  how many were independent, and the evidence from each.
- Model the contributing sources as an **open set of records keyed by a source id**, not as a
  struct with one field per source. A fifteenth collector contributes by emitting a record;
  neither the schema nor the fold's contract changes.
- Every spine assertion uses the claim contract (`ClaimSupport`), and the contributing source
  records are its evidence — each carrying a locator (accession, pmid, doi, or regulatory
  reference). A signal that cannot produce a locator is not admitted as evidence.
- The section carries the shared coverage envelope. Signals discarded by organ resolution or by
  the corroboration threshold are counted; a fold that ends up with no rows reports `filtered`
  with a real `dropped_count`, never an empty `available`.
- Add **Monarch Initiative** as a Phase-1 collector: human gene→phenotype (HPO) and causal
  gene→disease (MONDO) associations. This is human loss-of-function phenotype evidence, which
  neither the mouse-knockout collector (IMPC) nor the Open Targets association scores carry.
- The spine folds over signals that already arrive. It re-fetches nothing, and it does not
  duplicate `safety_profile` — it reads the same collector outputs that section reads.

## Capabilities

### New Capabilities

- `target-safety-corroboration`: the per-organ evidence spine — an open contributing-source
  set, claim-contract assertions, and a coverage envelope that reports a real filter.
- `target-human-phenotype-evidence`: human phenotype and causal-disease associations for the
  assessed target, collected as a Phase-1 source and resolved onto the canonical organ
  vocabulary at its own boundary.

### Modified Capabilities

<!-- None. The spine conforms to the existing evidence, coverage, and organ-vocabulary
     requirements rather than changing them. -->

## Impact

- `src/contracts/target-dossier.ts` — new `safety_corroboration` section on `DossierSchema`.
- `src/workflows/target-assessment/lib/safety-corroboration.ts` — the fold.
- `src/workflows/target-assessment/lib/hpo-organ-map.ts`,
  `src/workflows/target-assessment/lib/impc-organ-map.ts` — organ resolution for the two
  sources whose vocabularies are not already canonical.
- `src/tools/lib/monarch-client.ts` — the new keyless public API client.
- `src/workflows/target-assessment/collectors/index.ts`, `schemas.ts`,
  `src/workflows/execute-target-assessment.ts` — the new collector and its manifest entry.
- `src/workflows/target-assessment/assemblers/orchestrator.ts`, `phase5-persist.ts` — the
  section placeholder and the stamp.
- No new dependency; Monarch's v3 API is keyless and public.
