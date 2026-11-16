## ADDED Requirements

### Requirement: The root help groups its commands

The root `--help` MUST list the commands under group headings, for example Analyses, Agents, Data, Provenance and Setup. Each top-level command MUST belong to one group. The root help MUST NOT print the Paths and Environment tables. `inflexa help env` MUST print them.

#### Scenario: The root help shows groups

- **WHEN** the user runs `inflexa --help`
- **THEN** the output lists the commands under group headings, and it holds no Paths table

#### Scenario: The paths move to a help topic

- **WHEN** the user runs `inflexa help env`
- **THEN** the output holds the Paths and Environment tables

#### Scenario: A new command needs a group

- **WHEN** a test walks the top-level commands
- **THEN** it fails for a command that belongs to no group
