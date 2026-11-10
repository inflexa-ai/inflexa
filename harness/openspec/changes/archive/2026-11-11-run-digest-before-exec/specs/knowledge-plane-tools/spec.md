## MODIFIED Requirements

### Requirement: The decision record follows the script

The record on disk MUST carry the step, the claims, the digest of the script as the service rendered it, and `written_sha256`, the digest of the bytes the tool wrote. `edit_file` on a script under `scripts/` that has a record MUST append an entry to `unvetted_edits` with the path, a note, and the digest after the change. Before `execute_command` runs a script that has a record, it MUST compare the script with the last recorded digest, and a difference MUST be appended as an unvetted change with the digest of the bytes that run. A script without a record is untouched.

A command can name its script inside a shell line: the one element of an `sh -c` call, or a string after `bash -c`. `execute_command` MUST find each word of such a line that has a script extension. It MUST make the same comparison for each one. A word ends at whitespace, at a shell operator, at a quote, and at the `=` of an option. A `cd` in the line moves the words after it, and a subshell can end that move. Thus `execute_command` MUST resolve a relative word against the cwd of the command. It MUST also resolve the word against each directory that a `cd` before the word can give. The command MUST run as the model sent it.

Before `execute_command` runs a script that has a record, it MUST append an entry to `runs` in the record. The entry MUST hold `sha256`, the digest that the comparison before the run read, and `invocation`, the id of the tool call. After the command, the tool MUST add `exit_code`, the exit code of the command, to that entry. An entry with no `exit_code` is a run that did not end, and it MUST NOT count as a good run. A tool call that the host does again after a recovery MUST write no second entry. The entry from before the command does not say if the command ran before the host stopped. Thus that call MUST compare its digest with the digest of the entry. When the two agree, the entry keeps `sha256`. When the two differ, the entry MUST hold `sha256_before_the_command` and `sha256_at_the_recovery`, and it MUST hold no `sha256`. Such an entry is a run of no known script, and it MUST NOT count as a good run. If the write before the command fails, the tool MUST append the entry after the command. The tool MUST write the entries of one record in order, thus two commands that end together lose no entry. The tool MUST NOT read the script again after the run, because the run can change the script. The tool MUST write the entry only when the exit code of the command is the exit code of the script. A direct argv gives that when the script is the command. It also gives that when the script comes after a runner, for example `Rscript`, `python`, or `bash`. Only an option that still runs the script can be between the two, for example `--vanilla`. An option such as `--version` or `-e` MUST write no entry. A `cd` in a chain of `&&` moves the script, and a `cd` that the host cannot resolve MUST write no entry. A shell line gives that only when it is one such command, or a chain of `&&` that ends with one. Each command before the last one of a chain MUST be `cd` with one directory or `mkdir -p` with one directory. An output redirect and `2>&1` are permitted after the command. A line with a pipe, a list, a subshell, a quote, an expansion, or an input redirect MUST write no entry. A command that reads the script as data, for example `cat`, MUST write no entry. A failed write of the entry MUST NOT fail the call, because the command already ran. A record MUST keep no more than its last 50 entries.

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

#### Scenario: A run lands on the record

- **GIVEN** a rendered script and its record
- **WHEN** `execute_command` runs `Rscript scripts/de.R`, and the command ends with exit code 0
- **THEN** the two copies of the record hold a `runs` entry with `exit_code` 0 and the digest of the script
- **WHEN** `execute_command` runs `cat scripts/de.R`, or the one element `Rscript scripts/de.R | tee log.txt`
- **THEN** the record gets no entry

#### Scenario: A recovered call of a changed script names no script digest

- **GIVEN** a record with a `runs` entry of a tool call that holds a digest and no `exit_code`
- **AND** a script that now holds different bytes
- **WHEN** the host does that tool call again, and the command ends with exit code 0
- **THEN** the entry holds `exit_code` 0, `sha256_before_the_command`, and `sha256_at_the_recovery`
- **AND** the entry holds no `sha256`, thus no carried slot binds from it
- **AND** the record holds one entry of that tool call
- **WHEN** the script holds the same bytes at the recovery
- **THEN** the entry holds `exit_code` 0 and `sha256`
