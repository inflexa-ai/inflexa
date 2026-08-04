## Context

`src/contracts/target-dossier.ts` is the dossier contract, ~1600 lines, and it accumulated three
generations of shape at once — a base, a live intermediate the phase-4 assemblers emitted, and a
third that phase-5 produced by upgrading and validating the second. Consumers discriminated on a
`schema_version` literal.

That layering existed to protect rows written under earlier shapes. This package has not shipped
in the OSS yet: there are no such rows, no pinned consumers, and nothing to be compatible with.
The generations are carrying cost for a constraint that does not exist.

The coverage envelope is built by a `withCoverage` helper — a Zod discriminated union on the
`coverage` literal with three branches — but three sections hand-roll a `coverage` field
instead of calling it, so the invariant currently holds by convention rather than by
construction.

Organ naming is the worst of it. Two enums are both exported as `OrganSystem` and disagree on
membership *and* spelling: the safety panel keys on 9 short tokens (`hepatic`, `cns`, `gi`,
`hematologic`), while the tox-voice prompt vocabulary instructs models in 15 prose terms
(`hepatobiliary`, `central nervous system`, `gastrointestinal`, `haematologic` — note the
British spelling). Models are told one vocabulary; panel data is keyed in the other; the dossier
receives whichever the model emitted into free-string fields. Nothing joins.

This slice is the foundation for three queued capabilities (an evidence spine, per-organ
regulatory segmentation, a claim investigation loop), all of which need traceable claims and a
joinable organ key. Cortex's forked "v6" solved comparable problems and will be retired in
favour of this package, so its choices are a parity constraint — but only where they are sound
on their own terms.

## Goals / Non-Goals

**Goals:**

- Make a scored assertion without evidence unrepresentable at the type level, not merely
  discouraged by review.
- Reduce five organ vocabularies to one, such that per-organ evidence joins without string
  matching.
- Make coverage hold by construction: every enrichment-dependent section expresses it through
  the shared envelope, with no hand-rolled variants.
- Distinguish "the source returned nothing" from "our own threshold discarded rows".
- Ship one dossier schema with no version ladder, no superseded shapes, and no migration
  machinery, since this package has not shipped and has nothing to be compatible with.
- Land close enough to Cortex's v6 that its fork can be retired, deviating only where v6 is
  demonstrably wrong and recording each deviation.

**Non-Goals:**

- The v6 claim record (organ × mechanism identity, seven fixed axes, verdict, mitigation,
  risk level). This slice builds the invariant that record depends on, not the record.
- The safety-evidence spine, per-organ regulatory segmentation, and the Phase-4b investigation
  loop. Later slices.
- Any migration, backfill, or compatibility path for dossiers written by an earlier build.
- Any renderer or host concern. This package is host-agnostic.

## Decisions

### 1. One schema, no versioning

There is a single `DossierSchema`. Every prior generation is deleted rather than frozen, the
`.extend()` chains between them are flattened into their final field sets, and the
`schema_version` discriminator is removed entirely — with one shape there is nothing to
discriminate, and a version literal on a first release is speculative scaffolding.

The upgrade step that existed to lift the intermediate shape into the persisted one is deleted
too. The assemblers produce the one shape directly.

*Alternative rejected:* keeping the generations and adding a fourth. That preserves migration
machinery, a discriminator, and three dead shapes to serve rows that do not exist, and every
later slice would inherit the cost of threading new capability through all of them.

*Consequence for fork retirement:* Cortex's fork carries its own version ladder. Retiring it is a
port onto this shape, not a version negotiation — which is simpler, but means the adapter cannot
lean on a shared version number.

### 2. Reuse `EvidenceItemSchema` as the source reference; do not introduce a parallel one

The file already defines `EvidenceItemSchema` (pmid, doi, source, predicate, score, strength,
excerpt, metadata, regulatory reference) and an `EvidenceList` over it. Cortex v6 introduced a
separate `SourceRefSchema` for claim evidence, so its dossier carries two evidence vocabularies.

Build the claim wrapper over the existing `EvidenceItemSchema`. Introducing a second evidence
shape in a change whose entire purpose is collapsing duplicate vocabularies would be
self-defeating.

`EvidenceItemSchema` requires only `source`, which is weak for a claim — every locator field is
optional, so an "evidence item" can be a bare source string. Tighten it *for claim use* with a
refinement requiring at least one resolvable locator (pmid, doi, accession, or regulatory
reference), rather than loosening the claim wrapper to match the weakest existing producer.

*Deviation from v6, recorded:* claim evidence is `EvidenceItem`, not `SourceRef`. Field-level
mapping is mechanical; a fork-retirement adapter can translate.

### 3. Support is a two-branch union attached to the claim body

```
support: { state: "scored";  evidence: ClaimEvidence[] (min 1) }
       | { state: "unknown"; reason: string }
```

Discriminating on a `state` literal rather than on the presence of `evidence` is what buys the
type-level guarantee: `evidence` lives only on the scored branch and is non-empty there, so
"scored with no evidence" cannot be constructed. A nullable-evidence field with a runtime check
would not survive a careless producer.

The union attaches as a `support` field on the claim body rather than replacing the body with a
`value` wrapper. The three shapes bound by this slice — liability bullets, off-target rows,
off-tissue rows — are records that *are* the assertion, not attributes of one: the row's text,
organ, and identity have to survive on both branches. A wrapper that swaps the body for a
`reason` would make an unevidenced liability unreadable, when what a reader needs is the
liability *and* the reason nothing backs it.

An attribute-level form — where the value itself is absent when unknown — is the right shape for
scored axes of a claim record, and can be added when that record lands. It is not needed here.

### 4. `filtered` is a terminal state, and `available` reports its own drops

Two situations get conflated today, and they need different shapes:

- The filter ran and *nothing* survived → `filtered`, carrying `filter` (what ran) and
  `dropped_count` (how many it discarded). No `data` branch: there is nothing to show.
- The filter ran and *some* rows survived → `available`, with an optional `dropped_count` so the
  reader knows the list is partial.

Without the second half, a section that dropped 90% of its rows still reports a clean
`available` and silently overstates its own completeness.

`filtered` is added as a fourth branch of the existing union. `queried_no_data` keeps its name
and meaning. Cortex v6 renamed it to `no_record` *and* applied the new enum to only two of its
V5 sections — the rename is gratuitous and the partial application is the defect this change
exists to avoid, so neither is carried.

*Deviation from v6, recorded:* the third state stays `queried_no_data`.

### 5. Coverage is enforced by construction, and by a test that enumerates sections

Hand-rolled `coverage` fields migrate onto `withCoverage`. Because "every enrichment-dependent
section carries coverage" is not expressible in Zod, it gets a test that walks the dossier schema and
asserts every section under the enrichment-dependent keys is a coverage union — so a future
section added without an envelope fails the suite rather than review.

This is the mechanism that makes "lands whole or not at all" real rather than aspirational.

### 6. One canonical organ vocabulary, with prose as a display mapping

Canonical tokens are the safety panel's short snake_case style, extended to cover what the other
vocabularies could express. Cortex v6 chose the same style, which makes this the parity-aligned
option as well as the coherent one.

The starting point is not v6 but this package's own inline organ enum on the organ-rollup row, a
15-member list that v6's `OrganSystemSchema` reproduces exactly. v6 promoted an existing upstream
list to a named schema; it did not invent one. The canonical vocabulary is that list plus the
three members the tox-voice vocabulary could express and it could not.

Canonical set (18): `cardiac`, `vascular`, `hepatic`, `renal`, `cns`, `pns`, `gi`, `pancreas`,
`endocrine_thyroid`, `metabolic`, `hematologic`, `immune`, `respiratory`, `reproductive`,
`musculoskeletal`, `dermatologic`, `ocular`, `oncology`.

Two judgement calls in that list:

- **`vascular`, `pns`, and `ocular` are added.** The tox-voice vocabulary can express them today
  and models are actively instructed to, so omitting them would silently narrow what a model may
  report.
- **`oncology` and `endocrine_thyroid` are retained**, by owner ruling, despite neither being a
  clean organ system. Both are load-bearing in live producers: `lib/meddra-organ-map.ts`
  classifies MedDRA neoplasm and thyroid SOC terms onto them, and `assemblers/safety.ts`
  deliberately synthesizes an oncology rollup row when regulatory findings match malignancy
  keywords. Excluding them would discard those signals rather than re-home them. Retaining them
  also makes the vocabulary byte-identical to v6's, so fork retirement needs no mapping.
  **Known debt**, recorded in the module: a per-organ grouping has one key that does not denote
  a site, and the honest fix is a separate non-organ signal channel.

The tox-voice prose terms become display labels mapped from canonical tokens. Prompts instruct
models in canonical tokens directly — a model emitting prose that is then mapped back is lossy
(`central nervous system` and `cns` are recoverable; `hepatobiliary` versus `hepatic` is a
judgement call no mapping should be silently making).

*Alternative rejected:* keep both vocabularies and normalize at the boundary. That is what the
codebase does today, informally, and it is the defect.

### 7. Both existing `OrganSystem` exports are replaced, not deprecated

The canonical type is defined once and imported by the safety panel and the tox-voice module.
Leaving either in place as a deprecated alias preserves the ability to key data on the wrong
vocabulary, which is precisely what has to stop being possible.

## Risks / Trade-offs

- **Deviating from v6 on `oncology`, `endocrine`, and the evidence type widens the
  fork-retirement gap** → Each deviation is recorded above with its rationale and is
  mechanically mappable. The alternative — importing a known-incoherent key space to preserve
  byte-parity — makes every later per-organ capability inherit the incoherence.
- **Deleting the version ladder removes the ability to read a dossier written by an older
  build** → Accepted deliberately: the package has not shipped, so no such dossier exists. The
  cost lands the first time the shape changes after release, and the answer then is a real
  migration, not a ladder kept warm on speculation.
- **Constraining organ fields to an enum can reject model output that used to pass** → Producers
  must map or reject at the assembler boundary, not at persistence, so a bad organ name surfaces
  as an assembler-level failure with context rather than a schema error at the end of a long
  run.
- **The evidence invariant can push producers toward fabricating citations to satisfy the type**
  → The `unknown` branch has to be genuinely cheap to emit and prompts must say so explicitly.
  An invariant that is harder to satisfy honestly than dishonestly makes the data worse.
- **Widening `EvidenceItemSchema`'s effective requirements for claim use may break existing
  producers** → The refinement applies to the claim wrapper only, not to `EvidenceItemSchema`
  everywhere it is already used.

## Migration Plan

1. Add the canonical organ type and its display mapping; point the safety panel and tox-voice at
   it; remove both old exports.
2. Add the `filtered` branch and `available.dropped_count` to `withCoverage`; migrate the
   hand-rolled coverage sites; add the enumerating test.
3. Add the claim wrapper and its locator refinement.
4. Collapse the schema generations into one `DossierSchema`: flatten the `.extend()` chains,
   delete every superseded shape, drop `schema_version`, and apply the claim wrapper, the
   coverage envelope on `target_organ_liabilities`, and the canonical organ type.
5. Update phase-4 assemblers to produce the one shape and to map organ names at their boundary.
6. Delete the phase-5 upgrade step; persistence validates the single schema.
7. Update the coverage invariant statement in `harness/CLAUDE.md`.

No backfill and no migration: there are no persisted dossiers to carry forward.

Rollback is a code-only revert.

## Deviations from Cortex's v6

Consolidated for fork retirement. Each is deliberate and mechanically mappable.

| Deviation | Cortex v6 | Here | Why |
|-|-|-|-|
| Versioning | `schema_version: "6"` on a V3–V6 ladder | no version field, one schema | nothing shipped to be compatible with; the ladder was cost without a constraint |
| Third coverage state | renamed to `no_record` | stays `queried_no_data` | the rename buys nothing and breaks readers |
| Coverage application | new enum on 2 of its sections | all sections, one change | a partial migration makes the invariant unverifiable |
| Partial-filter reporting | none | `dropped_count` on `available` | a section that dropped most rows otherwise reports clean |
| Claim evidence type | new `SourceRefSchema` | existing `EvidenceItem` + locator refinement | a second evidence vocabulary in a change that collapses vocabularies |
| Claim shape | value-replacing wrapper | `support` field on the body | an unevidenced liability must still be readable |
| Organ vocabulary | 15 members | same 15 plus `vascular`, `pns`, `ocular` | the prose vocabulary could express them and models are instructed in them |

## Open Questions

- ~~`oncology`~~ — **resolved by owner ruling**: retained, along with `endocrine_thyroid`, as
  recorded in decision 6. The category error is accepted as known debt with a documented reason
  rather than fixed in this slice, because both members carry live producer signals that have
  nowhere else to go.
- ~~**Severity scale on enriched liability rows**~~ — **resolved**: the panel's
  `high | medium | low` is reused, and lifted into `contracts/severity.ts` so the panel and the
  dossier share one definition rather than two copies of the same three words.
