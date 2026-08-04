## 1. Organ resolution for the non-canonical source vocabularies

- [x] 1.1 Move the IMPC top-level-phenotype bucket map out of the Phase-4 orchestrator into a
      shared `lib/impc-organ-map.ts`, typed against the canonical `OrganSystem`, and repoint the
      orchestrator at it
- [x] 1.2 Add `lib/hpo-organ-map.ts` resolving an HPO term's ancestor closure onto the canonical
      organ vocabulary, most specific ancestor first, returning null when nothing matches

## 2. Monarch Initiative client

- [x] 2.1 Add `src/tools/lib/monarch-client.ts` with Zod-validated responses, bounded retries and
      timeouts via the shared fetch helper, empty results on a 4xx, and a throw on anything
      unexpected
- [x] 2.2 Fetch human gene-to-phenotype associations (HPO terms, ancestor closure, publications,
      disease context, frequency) filtered to human subject taxon
- [x] 2.3 Fetch causal gene-to-disease associations (MONDO terms, primary knowledge source)
- [x] 2.4 Add an integration test under `src/__tests__/integration/` asserting response
      structure, not values

## 3. Wire Monarch as a Phase-1 collector

- [x] 3.1 Add `MonarchBundleSchema` to the workflow schemas and to `Phase1BundleSchema`
- [x] 3.2 Add `collectMonarch` to the collector module and to `COLLECTOR_MANIFEST`, reporting
      `not_loaded` when no HGNC identifier resolved
- [x] 3.3 Key the new collector into the `Phase1Bundle` reconstruction in the workflow body

## 4. The corroboration section's contract

- [x] 4.1 Add the contribution, organ-record, and section schemas to
      `src/contracts/target-dossier.ts`, with the contributing sources as an array of
      self-naming records and the record's assertion on the claim contract
- [x] 4.2 Add the section to `DossierSchema` and document why the shape is open

## 5. The fold

- [x] 5.1 Add `lib/safety-corroboration.ts` with a registered `SIGNAL_SOURCES` array of
      `{id, extract}` entries over the already-collected inputs
- [x] 5.2 Register the extractors: FDA label organ signals, IMPC knockout organ systems, Monarch
      human phenotypes, Open Targets safety liabilities, and the expression atlas's
      safety-relevant high-expression tissues
- [x] 5.3 Group by canonical organ, count distinct source ids, apply the corroboration
      threshold, and build the claim support from the contributions' evidence
- [x] 5.4 Return the coverage envelope: `available` with `dropped_count` when signals were
      discarded, `filtered` with the filter and a real `dropped_count` when nothing survives,
      `queried_no_data` when no source produced a signal

## 6. Wire the section into the workflow

- [x] 6.1 Stamp the Phase-4 placeholder as `not_loaded`
- [x] 6.2 Stamp the assembled section in Phase-5 persist from the Phase-1 bundle and the
      segmented FDA label signals

## 7. Tests and gates

- [x] 7.1 Unit-test the fold: multi-source corroboration, single-source drop, unresolvable organ
      drop, missing-locator drop, all-discarded → `filtered`, no-signal → `queried_no_data`
- [x] 7.2 Unit-test the HPO organ resolution, including specific-over-broad and the null case
- [x] 7.3 Run typecheck, the test suite, lint, and the formatter on every changed source file
