# target-dossier-coverage Specification

## Purpose
TBD - created by archiving change target-assessment-schema-foundation. Update Purpose after archive.
## Requirements
### Requirement: Every enrichment-dependent dossier section SHALL carry a coverage state

Every dossier section whose content depends on an external enrichment source SHALL carry a
`coverage` discriminator declaring whether that source was consulted and what it returned. A
section that can be empty for more than one reason SHALL NOT represent those reasons as the
same empty value.

#### Scenario: Section populated from a source that returned rows

- **WHEN** an enrichment source is queried and returns rows that survive any applied filter
- **THEN** the section carries `coverage: "available"` and its `data` field holds the rows

#### Scenario: Section whose source was queried and held nothing

- **WHEN** an enrichment source is queried and returns no rows at all
- **THEN** the section carries `coverage: "queried_no_data"` and no `data` field is present

#### Scenario: Section whose source was never consulted

- **WHEN** an enrichment source is not consulted during the assessment
- **THEN** the section carries `coverage: "not_loaded"` and no `data` field is present

#### Scenario: Empty section is never ambiguous

- **WHEN** a consumer reads a section holding no rows
- **THEN** the coverage discriminator alone determines whether the source was unqueried, queried
  and empty, or emptied by a filter, with no inspection of other fields required

### Requirement: A filter that removes every row SHALL be reported as filtered, not as no data

The dossier SHALL distinguish an enrichment source that returned nothing from one that returned
rows which the assessment's own thresholds then discarded. When a filter removes every row, the
section SHALL report `coverage: "filtered"` together with the filter that ran and the number of
rows it discarded.

#### Scenario: Filter discards every returned row

- **WHEN** a source returns rows and an applied filter discards all of them
- **THEN** the section carries `coverage: "filtered"`, a `filter` describing what ran, and a
  `dropped_count` of the rows discarded
- **AND** no `data` field is present

#### Scenario: Filter discards some rows

- **WHEN** a source returns rows and an applied filter discards some but not all of them
- **THEN** the section carries `coverage: "available"` with the surviving rows in `data`
- **AND** a `dropped_count` reporting how many rows the filter discarded

#### Scenario: No filter applied

- **WHEN** a source returns rows and no filter is applied
- **THEN** the section carries `coverage: "available"` and reports no `dropped_count`

### Requirement: The existing three coverage states SHALL keep their names and meanings

Adding the filtered state SHALL be strictly additive. The states `available`,
`queried_no_data`, and `not_loaded` SHALL retain their spellings and semantics, so that a
consumer written against the three-state contract continues to interpret those three states
correctly.

#### Scenario: Consumer written against three states reads a new dossier

- **WHEN** a consumer that knows only `available`, `queried_no_data`, and `not_loaded` reads a
  section carrying one of those three states
- **THEN** the state's meaning is unchanged from the three-state contract

#### Scenario: Filtered state encountered by an older consumer

- **WHEN** such a consumer encounters `coverage: "filtered"`
- **THEN** it encounters an unknown state rather than a silently altered known one

### Requirement: Sections SHALL express coverage through the shared envelope

A dossier section SHALL obtain its coverage discriminator from the shared coverage envelope
rather than declaring a `coverage` field of its own. Hand-rolled coverage fields SHALL NOT
exist in the dossier contract.

#### Scenario: New section added to the dossier

- **WHEN** a new enrichment-dependent section is added without the shared coverage envelope
- **THEN** the contract's coverage conformance test fails

#### Scenario: Coverage states extended in future

- **WHEN** the set of coverage states is extended
- **THEN** every section obtains the new state through the shared envelope without individual
  section edits

### Requirement: The per-organ liability section SHALL carry coverage

The section reporting per-organ target liabilities SHALL carry a coverage state like every other
enrichment-dependent section. An empty liability list SHALL NOT be the only signal a consumer
receives about whether liabilities were assessed.

#### Scenario: Liabilities assessed and found

- **WHEN** organ liabilities are derived and at least one is found
- **THEN** the section carries `coverage: "available"` with the liability rows in `data`

#### Scenario: Liabilities assessed and none found

- **WHEN** organ liabilities are derived and none are found
- **THEN** the section carries `coverage: "queried_no_data"`

#### Scenario: Liability derivation never ran

- **WHEN** the inputs required to derive organ liabilities were not loaded
- **THEN** the section carries `coverage: "not_loaded"` and a consumer can distinguish this from
  an assessment that found no liabilities

