## ADDED Requirements

### Requirement: A scored dossier assertion SHALL carry at least one piece of evidence

Every scored assertion in a target dossier SHALL carry a non-empty list of evidence items. An
assertion that cannot be evidenced SHALL be expressed as unknown with a stated reason rather
than as a scored assertion with empty or absent evidence. The contract SHALL make a scored
assertion with no evidence unrepresentable rather than merely invalid.

#### Scenario: Assertion backed by evidence

- **WHEN** a producer emits an assertion it can support
- **THEN** the assertion is in the scored state, carrying its value and at least one evidence
  item

#### Scenario: Assertion that cannot be supported

- **WHEN** a producer cannot support an assertion with any evidence
- **THEN** the assertion is in the unknown state, carrying a reason and no value

#### Scenario: Scored assertion with empty evidence cannot be constructed

- **WHEN** a producer attempts to emit a scored assertion with an empty evidence list
- **THEN** the value does not satisfy the dossier contract

#### Scenario: Unknown is available without penalty

- **WHEN** evidence is unavailable for an assertion
- **THEN** emitting the unknown state is a valid and complete outcome, not a degraded or
  error-carrying one

### Requirement: Claim evidence SHALL resolve to an identifiable source

An evidence item attached to a dossier assertion SHALL carry at least one locator that
identifies where the evidence came from — a publication identifier, a digital object
identifier, a database accession, or a regulatory document reference. A bare source name SHALL
NOT satisfy the evidence requirement for an assertion.

#### Scenario: Evidence carrying a publication identifier

- **WHEN** an assertion cites literature
- **THEN** its evidence item carries a publication identifier or digital object identifier

#### Scenario: Evidence carrying a database accession

- **WHEN** an assertion derives from a queried database record
- **THEN** its evidence item carries the accession identifying that record

#### Scenario: Evidence carrying a regulatory reference

- **WHEN** an assertion derives from a regulatory document
- **THEN** its evidence item carries the document reference and, where applicable, the section

#### Scenario: Evidence naming only a source

- **WHEN** an evidence item names a source but carries no locator of any kind
- **THEN** it does not satisfy the evidence requirement for a scored assertion

### Requirement: The evidence-bearing form SHALL apply to liability, off-target, and off-tissue assertions

Liability bullets, off-target panel rows, and off-tissue risk rows SHALL each carry their
assertions in the evidence-bearing form. These are the dossier shapes that assert a safety
finding, and a consumer SHALL be able to trace any of them to a source.

#### Scenario: Liability bullet is traceable

- **WHEN** a consumer reads a liability bullet asserting a safety concern
- **THEN** it can reach the evidence supporting that concern, or a stated reason the concern is
  unevidenced

#### Scenario: Off-target row is traceable

- **WHEN** a consumer reads an off-target panel row
- **THEN** it can reach the evidence supporting that off-target assertion, or a stated reason

#### Scenario: Off-tissue row is traceable

- **WHEN** a consumer reads an off-tissue risk row
- **THEN** it can reach the evidence supporting that expression assertion, or a stated reason

#### Scenario: Evidence survives persistence

- **WHEN** an assertion carrying evidence is persisted and later read back
- **THEN** the evidence is present in the read-back assertion
