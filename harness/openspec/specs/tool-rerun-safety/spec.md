# tool-rerun-safety Specification

## Purpose
A tool call that runs again after a crash gives the same effect and the same result. A crash can come after the write of a tool and before the checkpoint of its step.

## Requirements

### Requirement: A tool call that writes keys its write by the call

A tool that writes MUST key its write by the step of its call. A tool that a script calls MUST also key its write by its call, because the calls of one script share the step of `run_script`. A second run of the same call MUST find the first write, and it MUST give the result of the first run. It MUST NOT write a second row, start a second run, or refuse its own earlier write.

#### Scenario: A rerun of execute_analysis

- **GIVEN** an `execute_analysis` call that launched its run, and then the host stopped before the checkpoint
- **WHEN** the call runs again
- **THEN** the call gives the same run id, and no second run starts

#### Scenario: A rerun of start_report_session

- **WHEN** a `start_report_session` call runs again after a crash
- **THEN** it gives the same child thread and the same chat part, and it does not answer `existing-session`

#### Scenario: A rerun of an authoring call

- **WHEN** an `add_block` call runs again after its block landed
- **THEN** it gives its stored result, and it does not refuse its own block id

#### Scenario: Two edits of one script

- **WHEN** one script calls `add_block` two times with two blocks
- **THEN** both blocks land, and the second call does not give the stored result of the first

#### Scenario: A rerun of a memory edit

- **WHEN** an `update_working_memory` call that adds an entry runs again after a crash
- **THEN** the section holds the entry one time, and the call gives ok

#### Scenario: A rerun of record_report_version

- **WHEN** a `record_report_version` call runs again after a crash
- **THEN** it gives the same version, and the result does not say `replaced`

### Requirement: A cut tool output and a usage record of a turn have stable keys

A workflow can run with no run frame. Then the reference of a cut tool output and the key of a usage record MUST come from the id of the workflow. A rerun of the call MUST give the same reference and the same key.

#### Scenario: A rerun of a long tool result in a chat turn

- **WHEN** a tool call of a chat turn with a long result runs again after a crash
- **THEN** the excerpt names the same reference, and the store holds one row for it
