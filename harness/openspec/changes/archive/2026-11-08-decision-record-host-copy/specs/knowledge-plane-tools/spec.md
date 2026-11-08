## ADDED Requirements

### Requirement: The host keeps a copy of each decision record

Each write of a decision record MUST land two copies with the same bytes. The copy in the step stays at `output/decision_record_<script>.json`. The host copy MUST go under `.sandbox/decision-records/`, at the analysis-relative path of the copy in the step. The copy in the step MUST land first, through the mutator of the tool. The host copy MUST land after it, with the hardened landing of the mutator. A write of a host copy records no provenance, because the copy in the step carries it.

`knowledge_template` MUST write the host copy of each record that it writes. `edit_file` and `execute_command` MUST read the host copy of a record first. A change note MUST land in both copies. When the mutator refuses the copy in the step, the note MUST still land in the host copy. A record with no host copy is a record that an earlier version wrote. The tools MUST note a change in such a record in the copy in the step only. Thus a file in the step never becomes a host record.

Before `execute_command` runs a script, it MUST compare the copy in the step with the host copy. When the copy in the step is absent or differs, the tool MUST write it again from the host copy. The result MUST name each such record in `decision_records_restored`, and the host MUST log a warning. After the agent loop, the host MUST write again each absent or changed copy in the step, before the walk of the artifacts. The host MUST NOT follow a symbolic link in place of a copy. After that restore, the provenance record of a copy MUST stay only when a file tool wrote the same bytes. Otherwise the file falls to the step activity, because no other producer wrote those bytes.

#### Scenario: A command removed the records of the step

- **GIVEN** a rendered script, and its record in the step and on the host
- **AND** a command removed `output/decision_record_de.json`
- **WHEN** `execute_command` runs the script
- **THEN** the copy in the step has the bytes of the host copy again before the script runs
- **AND** the result names the record in `decision_records_restored`

#### Scenario: A command changed the copy in the step

- **GIVEN** a host record with the digest of the rendered script
- **AND** a copy in the step that claims the digest of changed bytes
- **WHEN** `execute_command` runs the changed script
- **THEN** the host copy lists the change with the digest of the bytes that run
- **AND** the copy in the step has the bytes of the host copy

#### Scenario: A symlink in place of the copy in the step

- **GIVEN** a host record, and a symlink in place of its copy in the step
- **WHEN** `execute_command` runs a changed script of that record
- **THEN** the host copy lists the change, and the target of the symlink stays unchanged

#### Scenario: A record that an earlier version wrote

- **GIVEN** a record in the step with no host copy
- **WHEN** `execute_command` runs a changed script of that record
- **THEN** the copy in the step lists the change, and the host holds no copy of the record

## MODIFIED Requirements

### Requirement: The briefing gives the methods of each upstream step

At dispatch the parent MUST give the handoff of each completed dependency the methods of that dependency. The methods come from the grounding of its plan step, the claim views of the run input, and the host copies of its records. The read of the records MUST be the confined and bounded read of the methods of a step. The handoff MUST render the grounding and the snapshot digest, each template with its method, and the rules and the sources of the dependency. The rules and the sources MUST each be bounded by `UPSTREAM_METHODS_MAX_ITEMS`, with a count of the tail. The handoff MUST also list the in-sandbox path of the copy in the step of each decision record, bounded by `MAX_UPSTREAM_DECISION_RECORDS`. A dependency with no grounding and no record MUST render as before.

#### Scenario: A report step after a grounded step

- **GIVEN** a step `T1S1` with a grounding that cites `R-0001@e7d0`, and a decision record of `tpl-deseq2-two-group@1.0.0` with one DOI
- **WHEN** the parent composes the seed of a step that depends on `T1S1`
- **THEN** the handoff of `T1S1` renders the grounding, the template with its method, the title of `R-0001@e7d0`, and the DOI
- **AND** the handoff lists the path of the decision record

#### Scenario: A dependency with no methods

- **WHEN** the parent composes the seed of a step whose dependency has no grounding and no decision record
- **THEN** the handoff of the dependency has no grounding line and no decision record line
