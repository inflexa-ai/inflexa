# Spec Delta

## ADDED Requirements

### Requirement: A derivation of a small table runs in a script

The report agent MUST have `read_table` and `write_derived` as script tools, thus a derivation of a table of up to 16 MiB starts no container. `read_table` MUST read only a member whose bytes match its pinned hash. `write_derived` MUST write a new name under the derived directory of the session, and its record MUST hold each input that the script read, the code of the script, and the output hash. A larger table does not derive.

#### Scenario: A script derives a table with no container

- **WHEN** a script reads a pinned table, sums a column by group, and writes `by_group.csv` with the pinned table as its input
- **THEN** the session state holds one derivation record with the source hash, the script text, and the output hash
- **AND** no sandbox starts

#### Scenario: A rerun of the call gives its record back

- **GIVEN** a script whose derivation record landed
- **WHEN** the step of the call runs again
- **THEN** the call gives the record back, and no second record lands

#### Scenario: A pinned table whose bytes changed

- **WHEN** a script reads a pinned table whose bytes no longer match the pinned hash
- **THEN** the call throws an Error that says that the table changed after the pin

#### Scenario: The scripts of a session stay beside its page

- **WHEN** a script runs in the report thread `t-1`
- **THEN** its code is at `report-sessions/t-1/scripts/{invocationId}.js`

### Requirement: A derived table is a member of the session

The gateway MUST serve each derivation record of the session as a member of the pinned snapshot, keyed by its output path and its output hash. Thus a derived table binds, resolves, and chains the same as a pinned table. The stored pin MUST NOT change.

#### Scenario: A block binds a derived table

- **GIVEN** a session whose derivation record names `report-sessions/t-1/derived/by_group.csv`
- **WHEN** a chart block binds that path
- **THEN** the reference resolves against the output hash of the record
