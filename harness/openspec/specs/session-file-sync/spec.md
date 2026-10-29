# session-file-sync Specification

## Purpose
A chat thread and a report session write files outside a run. A host that keeps the files of an analysis in its own store gets each such file, with its bytes and its owner, through one optional notice.

## Requirements

### Requirement: A file of a session reaches the file sync of the host

The harness MUST declare an optional notice `syncSessionFile` on `CoreRuntimeDeps`. Each file that a chat thread or a report session writes outside a run MUST reach it with the session of the tool call, its analysis-relative path, its hash, its size, its exact bytes, and its owner. The call MUST run inside the tool step of the write, thus a step that runs again calls it again with the same file. A failed notice MUST go to the log, and the write MUST stay done.

#### Scenario: No hook

- **WHEN** no `syncSessionFile` is bound
- **THEN** each write lands in the workspace tree alone, and nothing else changes

### Requirement: The owner of a session file is the thread or the analysis

The owner MUST be the thread for a script and a derived file of the scratch directory of the session, and for a derived table of a report session. The owner MUST be the analysis for a `write_file` or `edit_file` write of the conversation agent, because such a path is anywhere in the analysis tree.

#### Scenario: A derived file of a script

- **GIVEN** a bound `syncSessionFile`
- **WHEN** a script of the thread `thread-1` writes `top.csv`
- **THEN** the hook receives the saved script and `conversation-sessions/thread-1/derived/top.csv`, each owned by the thread `thread-1`, with its bytes

#### Scenario: A write of write_file

- **GIVEN** a bound `syncSessionFile`
- **WHEN** the conversation agent writes `notes/summary.md`
- **THEN** the hook receives `notes/summary.md` owned by the analysis, with its bytes
