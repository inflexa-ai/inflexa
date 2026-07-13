## ADDED Requirements

### Requirement: Lineage output distinguishes recorded absence from attribution gaps

The lineage renderer SHALL word an empty input branch by what the record
actually claims, distinguishing three absence kinds: **by-design absence** — a
`inflexa:FileToolWrite` activity's empty input side renders as a positive
agent-authored claim, not a hedge; **recorded absence** — a `inflexa:Command`
activity's empty input side keeps the hedged "no recorded inputs" wording;
**attribution gap** — in a backward walk, an activity carrying
`inflexa:unresolvedScript` renders the unresolved script beneath the activity,
visually distinct from input files, and the tree output SHALL end with a note
counting the walk's distinct gap activities. The gap is a lost INPUT
attribution, so forward trees (which render outputs) SHALL NOT print it — the
JSON/dot/mermaid projections carry it in both directions. No note SHALL appear
when the rendered walk contains no gaps. The JSON projection SHALL expose the same gap data (tree/JSON parity),
and documents written before the attribute existed SHALL render unchanged.

#### Scenario: Agent-authored file renders a positive no-inputs claim

- **WHEN** backward lineage reaches a `inflexa:FileToolWrite` activity with no used files
- **THEN** the empty branch reads as agent-authored, by-design absence (e.g. "agent-authored — no file inputs by design"), not "no recorded inputs"

#### Scenario: A command's empty input side stays hedged

- **WHEN** backward lineage reaches an `inflexa:Command` activity with no used files
- **THEN** the branch renders the hedged "no recorded inputs"

#### Scenario: An unresolved script renders inline and is counted

- **WHEN** a backward walk renders an activity carrying `inflexa:unresolvedScript: "scripts/de.R"`
- **THEN** the tree prints the unresolved script path beneath that activity, marked as unattributable rather than as an input file, and the output ends with a note counting the walk's attribution gaps

#### Scenario: No gaps, no note

- **WHEN** no activity in the rendered walk carries `inflexa:unresolvedScript`
- **THEN** the tree output carries no trailing gap note

#### Scenario: JSON exposes the same gap data

- **WHEN** `--format json` renders a walk containing an unresolved-script activity
- **THEN** that activity's node carries the unresolved-script field, and the dot/mermaid labels derived from the projection mark the gap

#### Scenario: Old documents render as today

- **WHEN** the walked document predates `inflexa:unresolvedScript`
- **THEN** the output is byte-identical to the prior rendering — hedged wordings for commands, no trailing note
