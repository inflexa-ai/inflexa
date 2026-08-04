## ADDED Requirements

### Requirement: The dossier SHALL carry a per-organ corroboration section

The dossier SHALL carry a section that folds every organ-bearing safety signal a run produced
into one record per canonical organ, stating which sources carry a signal for that organ, how
many of them are independent, and the evidence each contributed. A reader SHALL be able to
determine cross-source agreement for an organ from this section alone, without joining sections
by hand.

#### Scenario: Several sources carry a signal for one organ

- **WHEN** two or more independent sources each carry a safety signal attributed to the same
  canonical organ
- **THEN** the section holds one record for that organ, naming each contributing source and
  carrying the evidence each supplied

#### Scenario: Independent source count is reported

- **WHEN** a reader inspects an organ's corroboration record
- **THEN** the record states how many distinct sources contributed to it

#### Scenario: One source contributes several signals for one organ

- **WHEN** a single source carries more than one signal for the same organ
- **THEN** every one of those signals is present as its own contribution
- **AND** the independent source count for that organ counts the source once

#### Scenario: Organ key joins without normalization

- **WHEN** a consumer joins a corroboration record to another dossier section by organ
- **THEN** equality on the canonical organ token is sufficient

### Requirement: The contributing-source list SHALL be open

The set of sources able to contribute to the corroboration section SHALL be open: a source
contributes by emitting a record that names itself, and the section's schema SHALL NOT
enumerate sources as fields, as an enum, or as any other closed form. Introducing an additional
source SHALL NOT change the section's schema or the fold's contract.

#### Scenario: A new source is introduced

- **WHEN** a source that did not previously contribute begins emitting per-organ signals
- **THEN** its contributions appear in the section without any change to the section's schema

#### Scenario: Consumers are unaffected by a new source

- **WHEN** a source is added
- **THEN** a consumer written against the section's schema reads the new contributions with no
  change of its own

#### Scenario: Source identity travels with the contribution

- **WHEN** a reader inspects a single contribution
- **THEN** it names the source that produced it, without reference to the contribution's
  position or to a field name

### Requirement: Every corroboration assertion SHALL use the claim contract

Each corroboration record SHALL express its assertion through the shared claim contract, and
the contributing source records SHALL be that claim's evidence. Each contribution SHALL carry a
locator identifying where its signal came from — an accession, a publication identifier, a
digital object identifier, or a regulatory document reference.

#### Scenario: Corroborated organ carries its evidence

- **WHEN** an organ record is emitted
- **THEN** its claim is in the scored state, carrying one evidence item per contribution

#### Scenario: Contribution without a locator

- **WHEN** a signal reaches the fold with no locator of any kind
- **THEN** it is not admitted as a contribution, and it is counted among the discarded signals

#### Scenario: Evidence traces back to a record

- **WHEN** a reader follows a contribution's evidence
- **THEN** the locator identifies the source record the signal was read from

### Requirement: The corroboration section SHALL carry a coverage envelope

The section SHALL obtain its coverage state from the shared coverage envelope. When the fold
runs and every signal is discarded — by organ resolution, by a missing locator, or by the
corroboration threshold — the section SHALL report `filtered` with the filter that ran and the
count of signals it discarded, and SHALL NOT report an empty `available`.

#### Scenario: Fold discards every signal

- **WHEN** signals reach the fold and none of them survive to become a record
- **THEN** the section carries `coverage: "filtered"`, a `filter` naming what ran, and a
  `dropped_count` greater than zero

#### Scenario: Fold discards some signals

- **WHEN** some signals become records and others are discarded
- **THEN** the section carries `coverage: "available"` with the surviving records
- **AND** a `dropped_count` reporting the discarded signals

#### Scenario: No source produced a signal

- **WHEN** the fold runs and no source produced any organ-bearing signal
- **THEN** the section carries `coverage: "queried_no_data"`

#### Scenario: Fold never ran

- **WHEN** the inputs the fold reads were not assembled
- **THEN** the section carries `coverage: "not_loaded"` and a consumer distinguishes this from a
  fold that found nothing

### Requirement: The fold SHALL NOT re-fetch or duplicate an existing evidence path

The corroboration section SHALL be derived entirely from signals already obtained by the run,
and SHALL NOT issue its own requests to any external source. It SHALL NOT restate an existing
dossier section's rows as a second evidence path for the same finding.

#### Scenario: Fold issues no external request

- **WHEN** the corroboration section is assembled
- **THEN** no external request is made on its behalf

#### Scenario: A source already has its own section

- **WHEN** a contributing source also populates a section of its own
- **THEN** the corroboration record references that source's signal as a contribution rather
  than re-deriving the section's content

#### Scenario: A source is unavailable for the run

- **WHEN** a source's collector returned no data
- **THEN** the fold proceeds with the remaining sources and that source contributes nothing
