## ADDED Requirements

### Requirement: Show runs command

The palette SHALL offer a "Show runs" command that opens the searchable runs picker defined by
`sidebar-live`'s picker → detail flow: a `SelectDialog` over the analysis's runs fetched fresh at
open (newest-first, capped at 100 with the cap stated when reached), whose selection pushes the
run-detail dialog over the still-mounted picker. The command SHALL be a single `Command` registry
entry with a stable dotted id (remappable via `config.keybinds`), and its `enabled(ctx)` predicate
SHALL gate on the harness runtime being ready (the fetch needs the booted pool). The RUNS sidebar
section's mouse activation and its existing leader chord SHALL route through the same open path as
the command, so all three entry points show one identical picker. The dialogs SHALL act only
through the command/dialog surface (`openDialog`/`closeDialog`/dialog host) and SHALL NOT write to
stdout.

#### Scenario: The command opens the runs picker

- **WHEN** the runtime is ready and the user runs "Show runs" from the palette
- **THEN** the searchable runs picker opens listing the analysis's runs newest-first

#### Scenario: All entry points share one picker

- **WHEN** the user opens runs via the palette command, the RUNS section click, or the leader chord
- **THEN** the same picker (same fetch, rows, and selection behavior) appears in each case

#### Scenario: The command is disabled before the runtime is ready

- **WHEN** the harness runtime has not reached ready
- **THEN** "Show runs" is disabled in the palette and no ledger query fires
