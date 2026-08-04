# target-claim-investigation Specification

## Purpose
TBD - created by archiving change target-assessment-claim-investigation. Update Purpose after archive.
## Requirements
### Requirement: Corroborated organ claims SHALL be interrogated before synthesis

Every corroborated organ claim admitted by the assessment SHALL be put through an investigation that
proposes a mechanism, argues against the claim, re-verifies it, and records a verdict, and that
investigation SHALL complete before the assessment writes its synthesis prose. Cross-source agreement
SHALL NOT be reported as though it were adjudication.

#### Scenario: A corroborated organ is investigated

- **WHEN** the corroboration fold admits an organ record and the investigation budget has room for it
- **THEN** the assessment produces an investigated-claim row for that organ carrying a verdict

#### Scenario: Synthesis sees the verdicts

- **WHEN** the synthesis steps run
- **THEN** the dossier they are given already carries the investigation section

#### Scenario: No corroborated claim exists

- **WHEN** the corroboration fold admits no organ record
- **THEN** the investigation section reports that it ran and found nothing to interrogate, and no
  investigated-claim row is emitted

### Requirement: The critique step SHALL argue against the claim

The investigation SHALL include a distinct critique step whose stated task is to argue that the claim
does NOT hold. That step SHALL NOT be a confirmation of the proposed mechanism, and its output SHALL be
recorded alongside the verdict rather than folded into it.

#### Scenario: An objection is recorded

- **WHEN** the critique step runs against a proposed mechanism
- **THEN** the investigated-claim row carries the objection it raised, separately from the verdict

#### Scenario: The critique cannot be produced

- **WHEN** the critique step fails to produce an objection
- **THEN** the claim is reported as not investigated with the reason stated, and no verdict is asserted
  for it

#### Scenario: Objections are deduplicated by organ

- **WHEN** more than one objection is raised for the same organ across the investigation
- **THEN** the organ's row carries exactly one objection
- **AND** deduplication considers the organ alone, not the mechanism the objection was raised against

### Requirement: The investigation SHALL converge on a stated bound

Each claim's investigation SHALL iterate to an explicit stopping condition and SHALL NOT iterate
without a bound. The bound SHALL be configuration carrying a stated default rather than a constant
asserted as domain truth, and the value in force SHALL be reported in the investigation section.

#### Scenario: A verdict settles early

- **WHEN** a round produces a terminal verdict, or repeats the previous round's verdict
- **THEN** the investigation for that claim stops and records which stopping condition ended it

#### Scenario: The bound is reached

- **WHEN** the configured number of rounds runs without the verdict settling
- **THEN** the investigation for that claim stops at the bound and records that the bound ended it

#### Scenario: The bound is readable from the dossier

- **WHEN** a reader inspects the investigation section
- **THEN** the round bound and the claim budget that were in force are present in it

#### Scenario: The bound is configurable

- **WHEN** an embedder supplies its own bound
- **THEN** the investigation honours it, and the section reports the supplied value

### Requirement: Every investigation assertion SHALL use the claim contract

The mechanism, the objection, and the verdict SHALL each be expressed through the shared claim
contract: scored with at least one locator-bearing evidence item, or `unknown` with a stated reason.
A claim carrying a caveat in place of evidence SHALL NOT be representable, and the reason a claim is
unknown SHALL NOT be reported as a form of support.

#### Scenario: A verdict backed by evidence

- **WHEN** the re-verification can point at records supporting its verdict
- **THEN** the row's support is scored and carries those records as evidence

#### Scenario: A verdict that cannot be evidenced

- **WHEN** the re-verification can point at no record
- **THEN** the row's support is unknown with a reason, and the row still carries its verdict

#### Scenario: Cited support carries no locator

- **WHEN** a step returns support naming only a source, with no publication identifier, digital object
  identifier, accession, or regulatory reference
- **THEN** the phase resolves it to unknown with a reason at its own boundary, rather than emitting it
  as scored or failing the assessment

#### Scenario: Unknown is stated to be cheap

- **WHEN** a step's instructions are composed
- **THEN** they state that reporting unknown with a reason is a complete answer

### Requirement: Claim survival SHALL NOT be decided by a numeric score

The investigation SHALL express a claim's fate as a stated verdict drawn from a closed vocabulary, and
SHALL NOT compute a numeric soundness, confidence, or strength value to decide whether a claim
survives. No threshold SHALL act as a gate on whether a corroborated organ liability continues to be
reported.

#### Scenario: A weakened claim is still reported

- **WHEN** the critique weakens a claim without overturning it
- **THEN** the row records the weakened verdict and remains in the dossier

#### Scenario: An overturned claim is still reported

- **WHEN** the critique overturns a claim
- **THEN** the row records the overturned verdict and remains in the dossier, rather than being removed

#### Scenario: No numeric gate exists

- **WHEN** a reader inspects an investigated-claim row
- **THEN** it carries no numeric soundness value, and no value in it determines whether the claim was
  kept

### Requirement: The investigation SHALL report what it did not investigate

The investigation section SHALL name every candidate claim it did not investigate and the reason,
using the canonical organ vocabulary. A candidate omitted for budget, for lack of corroboration, or
because its own investigation failed SHALL be visible in the section rather than absent from it.

#### Scenario: A candidate exceeds the claim budget

- **WHEN** more corroborated claims exist than the claim budget admits
- **THEN** each admitted-but-unrun claim appears in the completeness list with the budget as its reason
- **AND** the section reports how many candidates the budget discarded

#### Scenario: An organ carries risk but no corroboration

- **WHEN** the dossier's per-organ risk rollup names an organ that the corroboration fold did not admit
- **THEN** that organ appears in the completeness list with lack of corroboration as its reason

#### Scenario: A single claim's investigation fails

- **WHEN** one claim's investigation cannot complete
- **THEN** that claim appears in the completeness list with the failure stated, and the remaining
  claims are still investigated

### Requirement: The investigation section SHALL carry a coverage envelope

The section SHALL obtain its coverage state from the shared coverage envelope, and SHALL degrade to
`not_loaded` when the phase could not run. A phase that did not run SHALL NOT be reported as a phase
that ran and found nothing.

#### Scenario: The phase could not run

- **WHEN** no corroboration record was assembled for the run
- **THEN** the section carries `coverage: "not_loaded"` with a reason, and no `data` field

#### Scenario: The phase ran with candidates

- **WHEN** at least one candidate claim reached the investigation
- **THEN** the section carries `coverage: "available"` with its rows, its completeness list, and the
  bounds in force

#### Scenario: The phase ran with no candidates

- **WHEN** the phase ran and no corroborated claim existed
- **THEN** the section carries `coverage: "queried_no_data"`

#### Scenario: Organ keys join without normalization

- **WHEN** a consumer joins an investigated-claim row to another dossier section by organ
- **THEN** equality on the canonical organ token is sufficient

