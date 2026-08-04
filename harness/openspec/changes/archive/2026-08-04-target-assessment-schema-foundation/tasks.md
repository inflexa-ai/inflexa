## 1. Canonical organ vocabulary

- [x] 1.1 Define the canonical organ-system enum and its inferred type in a single module, with the 17 members fixed in design (`cardiac`, `vascular`, `hepatic`, `renal`, `cns`, `pns`, `gi`, `pancreas`, `endocrine`, `metabolic`, `hematologic`, `immune`, `respiratory`, `reproductive`, `musculoskeletal`, `dermatologic`, `ocular`)
- [x] 1.2 Add the display-label mapping from canonical token to reader-facing prose, covering every member
- [x] 1.3 Point `src/data/safety-panel-schema.ts` at the canonical type and delete its local `ORGAN_SYSTEMS` / `OrganSystem` exports; update the safety-panel data rows whose `organ_system` values change spelling — no data rows needed respelling, all 7 values in use were already canonical
- [x] 1.4 Point `src/prompts/target-assessment/tox-voice/vocabulary.ts` at the canonical type, replacing its 15-term prose list and its own `OrganSystem` export; the prose terms survive only as display labels from 1.2
- [x] 1.5 Update every prompt that instructs a model to name an organ so it is given canonical tokens, not prose
- [x] 1.6 Verify no second organ enumeration remains anywhere in `src/` and that `OrganSystem` resolves to exactly one definition

## 2. Coverage envelope

- [x] 2.1 Add the `filtered` branch to `withCoverage` carrying `filter` and `dropped_count`, with no `data` field
- [x] 2.2 Add optional `dropped_count` to the `available` branch so a partially filtered section reports its own drops
- [x] 2.3 Migrate the sections that hand-roll a `coverage` field (`:398`, `:466`) — on inspection these are per-row source markers inside an already-enveloped section, not sections, so `withCoverage` would bury row identity; they take `RowCoverageSchema`, derived from the canonical enum via `.exclude(["filtered"])` so the two cannot drift
- [x] 2.4 Treatment for `final_coverage` (`:1139`): it records which state a synthesis step emitted rather than enveloping a section, so it takes `CoverageSchema.extract([...])` — derived, not restated
- [x] 2.5 Write the coverage conformance test that walks the dossier schema and asserts every enrichment-dependent section is a coverage union, so a future section added without an envelope fails the suite
- [x] 2.6 Confirm `available`, `queried_no_data`, and `not_loaded` are unchanged in spelling and semantics

## 3. Evidence-bearing claims

- [ ] 3.1 Add the two-branch claim wrapper (`scored` with non-empty evidence, `unknown` with a reason) discriminated on a `state` literal
- [ ] 3.2 Add the locator refinement for claim evidence requiring at least one of publication identifier, digital object identifier, accession, or regulatory reference — scoped to claim use, not to `EvidenceItemSchema` everywhere
- [x] 3.3 Add tests proving a scored assertion with empty evidence fails to parse, and that the unknown branch parses cleanly with only a reason

## 4. The dossier contract

- [x] 4.1 Collapse every schema generation into one unversioned `DossierSchema`: flatten the `.extend()` chains into final field sets, delete all superseded shapes, and drop the `schema_version` discriminator
- [x] 4.2 Apply the claim wrapper to liability bullets, off-target rows, and off-tissue rows
- [x] 4.3 Wrap `safety_profile.target_organ_liabilities` in the coverage envelope
- [x] 4.4 Enrich the liability row shape with evidence and a severity — the safety panel's `high | medium | low` is reused, lifted into `contracts/severity.ts` so panel and dossier share one definition
- [x] 4.5 Constrain every organ field (`organ`, `organ_system`, `organ_systems_with_phenotype`, and the derived risk/completeness organ lists) to the canonical type
- [x] 4.6 Export `DossierSchema`, `DossierBodySchema`, the claim and coverage primitives, and the organ/severity vocabularies from `src/contracts/index.ts`
- [x] 4.7 Add a parse test for a valid dossier — no prior-version fixture is needed, since no prior version exists

## 5. Producers

- [x] 5.1 Update the phase-4 assemblers to emit the claim wrapper for the three affected shapes
- [x] 5.2 Update the assemblers to emit the coverage envelope for `target_organ_liabilities`, including the `filtered` state where a threshold empties the section
- [x] 5.3 Add organ-name resolution at each assembler boundary that ingests an external or model-supplied organ name — `lib/meddra-organ-map.ts` already served this role and now resolves onto the canonical type instead of its own private one
- [x] 5.4 Audit the assemblers for filters that currently empty a section silently, and have them report `filtered` with a real `dropped_count` — off-tissue rows whose anatomy does not resolve onto an organ now yield `filtered` rather than an empty `available`

## 6. Persistence and state

- [x] 6.1 Delete the phase-5 upgrade step; persistence validates the single `DossierSchema` directly and the assemblers produce that shape
- [x] 6.2 ~~Confirm prior-version rows are returned unchanged~~ — void: no prior version exists, so `src/state/target-assessments.ts` reads one shape
- [x] 6.3 ~~Test that a stored dossier of each prior version is readable~~ — void for the same reason

## 7. Documentation and verification

- [x] 7.1 Update `harness/CLAUDE.md`: the coverage invariant now names four states and the shared envelope, the evidence invariant is stated alongside it, and the dossier is documented as a single unversioned shape
- [x] 7.2 Record the deviations from Cortex's v6 for fork retirement — consolidated as a table in `design.md`
- [x] 7.3 Run `tsc -p tsconfig.json` clean
- [x] 7.4 Run `bun test` — 1867 pass, 1 skip, 0 fail across 162 files
- [x] 7.5 Run `bun run format:file` on every changed file under `src/`; eslint clean
