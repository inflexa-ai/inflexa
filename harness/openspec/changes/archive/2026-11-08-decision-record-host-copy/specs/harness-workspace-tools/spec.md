## ADDED Requirements

### Requirement: The host copies of the decision records take no agent write

The host copies of the decision records are under `.sandbox/decision-records/`. Each confined write of a file tool MUST refuse a target under that directory with the `read_only` data variant, before any I/O. The variant carries a `reason` that names `.sandbox/decision-records/`. The landing MUST also refuse, as `read_only`, a target whose real path is under that directory. Thus a symbolic link cannot aim a write into it.

Each comparison MUST ignore case, because a case-insensitive volume gives one directory for two spellings. Only the record tools of the host write the host copies.

#### Scenario: A chat write of a host copy is read_only

- **GIVEN** a host copy of a decision record
- **WHEN** the model invokes `write_file` on that path, or on a new path under `.sandbox/decision-records/`
- **THEN** the result is a `read_only` data variant with a `reason` that names `.sandbox/decision-records/`
- **AND** the host copy stays unchanged, and no provenance event is emitted

#### Scenario: A case variant of the host copies is read_only

- **GIVEN** an analysis with no host copy yet
- **WHEN** the model invokes `write_file` on a path under `.sandbox/DECISION-RECORDS/`
- **THEN** the result is a `read_only` data variant, and no directory lands

#### Scenario: A symbolic link into the host copies is read_only

- **GIVEN** a symbolic link in a step directory whose target is a directory under `.sandbox/decision-records/`
- **WHEN** the model invokes `write_file` with a path through that link
- **THEN** the result is a `read_only` data variant, and the host copy stays unchanged
