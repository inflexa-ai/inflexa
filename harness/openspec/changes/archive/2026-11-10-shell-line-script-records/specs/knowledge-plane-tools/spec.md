## MODIFIED Requirements

### Requirement: The decision record follows the script

The record on disk MUST carry the step, the claims, the digest of the script as the service rendered it, and `written_sha256`, the digest of the bytes the tool wrote. `edit_file` on a script under `scripts/` that has a record MUST append an entry to `unvetted_edits` with the path, a note, and the digest after the change. Before `execute_command` runs a script that has a record, it MUST compare the script with the last recorded digest, and a difference MUST be appended as an unvetted change with the digest of the bytes that run. A script without a record is untouched.

A command can name its script inside a shell line: the one element of an `sh -c` call, or a string after `bash -c`. `execute_command` MUST find each word of such a line that has a script extension. It MUST make the same comparison for each one. A word ends at whitespace, at a shell operator, at a quote, and at the `=` of an option. A `cd` in the line moves the words after it, and a subshell can end that move. Thus `execute_command` MUST resolve a relative word against the cwd of the command. It MUST also resolve the word against each directory that a `cd` before the word can give. The command MUST run as the model sent it.

#### Scenario: An edit lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `edit_file` changes a marked line
- **THEN** the record lists the edit with the digest of the script after the change

#### Scenario: A change no tool recorded

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs it
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs

#### Scenario: A changed script in a shell line

- **GIVEN** a rendered script whose bytes differ from the last recorded digest
- **WHEN** `execute_command` runs the one element `cd scripts && Rscript de.R > log.txt`
- **THEN** the record lists the change with the digest of the bytes that run, before the command runs
- **AND** the command runs with no change
