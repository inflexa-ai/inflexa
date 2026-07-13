# command-palette — delta

## ADDED Requirements

### Requirement: Explore plan steps command

The palette SHALL offer an "Explore plan steps…" command that opens a `SelectDialog` over the steps
of the most recent plan card in the transcript and, on selection, opens a step-detail dialog. The
command SHALL be a single `Command` registry entry with a stable dotted id (remappable via
`config.keybinds`), and its `enabled(ctx)` predicate SHALL return false when the transcript holds no
plan card, so an empty selection is unreachable. The picker rows SHALL show each step's `id`, `name`,
and `agent`; the step-detail dialog SHALL render the step's `question`, `acceptance_criteria`,
`constraints`, `caveats`, `resources`, `agent`, and `depends_on` from the primitive fields the
plan-card part already carries — no harness round-trip. Both dialogs SHALL act only through the
`CommandContext` surface (`openDialog`/`closeDialog`) and SHALL NOT write to stdout.

#### Scenario: The command lists the latest plan's steps

- **WHEN** the transcript contains a plan card and the user runs "Explore plan steps…"
- **THEN** a `SelectDialog` lists that plan's steps by `id`, `name`, and `agent`

#### Scenario: Selecting a step opens its detail

- **WHEN** the user selects a step from the picker
- **THEN** a step-detail dialog shows that step's `question`, `acceptance_criteria`, `constraints`, `caveats`, `resources`, `agent`, and `depends_on`

#### Scenario: The command is hidden without a plan

- **WHEN** the transcript contains no plan card
- **THEN** "Explore plan steps…" is disabled and does not appear in the palette
