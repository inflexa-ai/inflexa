# Spec Delta

## ADDED Requirements

### Requirement: A derivation of a small table runs in a script

The report agent MUST have `read_table` and `write_derived` as script tools, thus a derivation of a table of up to 16 MiB starts no container. `read_table` MUST read only a pinned member whose bytes match the pinned hash. `write_derived` MUST keep the rules of the session derivation, and its record MUST hold the code of the script. `derive_table` stays for a larger table.

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
