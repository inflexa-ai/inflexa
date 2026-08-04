## Why

The target dossier asserts safety findings that a reader cannot trace, and reports coverage
it cannot honestly distinguish.

Three defects compound. Liability bullets persist as `{text, rationale, category}` — the
model's evidence pointer is a free string discarded at persistence, so a claim that an organ
carries a liability arrives with nothing behind it. Organ names are keyed five different ways,
including two mutually contradicting enums both exported as `OrganSystem`, so per-organ
evidence cannot be joined without string matching. And `safety_profile.target_organ_liabilities`
is the one enrichment-dependent section carrying no coverage envelope, so an empty array cannot
distinguish "checked, found nothing" from "never loaded" — for the section that most directly
drives a go/no-go call.

Target Assessment now lives in this package, and its capability has to grow substantially from
here: an evidence spine, per-organ regulatory segmentation, and a claim investigation loop are
all queued behind this. Every one of them needs claims that carry evidence and an organ key
that joins. Building them on the current schema means building them twice.

## What Changes

- Collapse the dossier's three accumulated schema generations into one unversioned
  `DossierSchema`: flatten the `.extend()` chains into their final field sets, delete every
  superseded shape and the upgrade step between them, and drop the `schema_version`
  discriminator. The layering existed to protect rows written under earlier shapes; this
  package has not shipped, so there are none.
- Introduce an evidence-or-unknown discriminated union as a dossier schema
  primitive: an assertion is either *scored*, carrying a non-empty list of structured source
  references, or *unknown*, carrying a reason. A scored assertion with no evidence becomes
  unrepresentable at the type level rather than merely discouraged. Applied to liability
  bullets, off-target rows, and off-tissue rows — the three shapes that today assert a finding
  with no traceable source.
- Collapse the five organ vocabularies into one canonical organ-system type that
  the safety panel, the dossier sections, and the tox-voice prompt vocabulary all resolve
  through. The free-string `organ` / `organ_system` fields migrate onto it; the prose
  vocabulary becomes a presentation mapping over the canonical tokens, not a second source of
  truth.
- Wrap `safety_profile.target_organ_liabilities` in a coverage envelope, and
  enrich its rows to carry evidence and a severity alongside the existing organ, trail, and
  mechanism hypothesis.
- Add a fourth coverage state, `filtered`, carrying the filter that ran and the count it
  dropped — distinguishing "the source returned nothing" from "our own threshold discarded
  rows". Strictly additive: the existing three states keep their names and meanings.
- Apply coverage uniformly. Sections that hand-roll a `coverage` field instead of going through
  the shared envelope builder are migrated onto it, so the invariant holds by construction
  rather than by convention.

The coverage work lands whole or not at all. A partial coverage migration leaves the invariant
unverifiable, which is the specific failure mode this change exists to avoid.

## Capabilities

### New Capabilities

- `target-dossier-evidence`: The evidence-or-unknown claim invariant — what a dossier assertion
  must carry to be representable, what a structured source reference is, and which sections are
  bound by it.
- `target-organ-vocabulary`: The single canonical organ-system vocabulary — its membership, the
  rule that no second vocabulary may exist, and how presentation surfaces map over it.
- `target-dossier-coverage`: Coverage discipline as a hard schema invariant — the four states
  and their exact semantics, the requirement that every enrichment-dependent section carries
  one, and that sections express it through the shared envelope rather than hand-rolling it.

### Modified Capabilities

None. `target-synthesis-grounding` is the only existing target-assessment spec and its
requirements are untouched by this slice.

## Impact

**Contracts** — `src/contracts/target-dossier.ts` in its entirety: the coverage primitives, the
liability, safety-flag, off-target and off-tissue shapes, the safety profile, and every
superseded generation of each. Two new modules carry the shared vocabularies the dossier and the
safety panel both key on.

**Vocabulary** — `src/data/safety-panel-schema.ts` (the 9-token enum) and
`src/prompts/target-assessment/tox-voice/vocabulary.ts` (the 15-term prose list), which
currently disagree on both membership and spelling while sharing an exported type name.

**Producers** — the phase-4 assemblers that populate the affected sections, the phase-5
persistence step (whose upgrade-between-generations logic is deleted outright), and any prompt
that instructs a model to emit an organ name or an evidence pointer.

**State** — `src/state/target-assessments.ts`, which reads persisted dossier rows.

**Documentation** — `harness/CLAUDE.md` states the coverage invariant as exactly three states;
it becomes wrong the moment `filtered` exists.

**Consumers** — the dossier is visible at the package boundary. Because this is the first OSS
release of it, the shape that lands here is the one hosts will write against, and Cortex's fork
retirement becomes a port onto it rather than a version negotiation.
