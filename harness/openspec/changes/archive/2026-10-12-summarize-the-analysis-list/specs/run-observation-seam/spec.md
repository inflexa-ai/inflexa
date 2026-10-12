# Spec Delta

## MODIFIED Requirements

### Requirement: The data-profile workflow emits no provenance

The data-profile workflow MUST expose no provenance hook. Its outputs (the ledger row, the profile
summary, the vector index entries) are reproducible derived metadata, unregistered as artifacts and
absent from every lineage surface — an observation of them would have no consumer. A profile arm
returns to the event union only together with a consumer of it.

The optional settle notice of the data-profile deps (see `data-profile-observation`) is not a
provenance hook. It reports only that a profile settled, for the records of the embedder, and it
adds no member to the provenance event union.

#### Scenario: A profile settles without observation

- **WHEN** a data profile runs to any terminal state
- **THEN** no provenance event is emitted and no provenance hook exists on its deps

#### Scenario: The settle notice emits no provenance

- **GIVEN** data-profile deps that carry a settle notice
- **WHEN** a data profile settles
- **THEN** the notice gets its settlement, and no provenance event is emitted
