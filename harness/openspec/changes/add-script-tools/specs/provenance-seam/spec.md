# Spec Delta

## ADDED Requirements

### Requirement: A script that reads or writes a file emits one event

The harness MUST emit one `run-script` session event for each script of `run_script` that read or wrote a file. The event MUST carry the analysis id, the thread id when the scope holds one, the invocation id of the `run_script` call, the saved script, each file that the script read with its hash, each file that it wrote with its hash and size, the tools that it called, and `ok`. The event MUST come from the fold of the call record, thus a replay emits it again with the same values.

#### Scenario: A script that derived a file emits

- **WHEN** a script reads one table and writes one derived file, and the member is bound
- **THEN** the member receives one `run-script` event with the read, the write, and the saved script

#### Scenario: A script of lookups emits nothing

- **WHEN** a script calls `pubmed` only
- **THEN** the member receives no event
