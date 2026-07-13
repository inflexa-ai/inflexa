# display-cards Specification

## Purpose
TBD - created by archiving change add-display-realization. Update Purpose after archive.
## Requirements
### Requirement: Display cards carry references, not bytes

Display-card parts SHALL carry semantic references — analysis-rooted paths,
ids, embedded specs — never resolved locations or file bytes. This governs the
card family: `data-presentation`, `data-file-reference`, `data-plan`,
`data-run-card`, and `data-report-preview`. Hosts SHALL resolve a reference to viewable content at render or open
time (the managed host via its artifact/content services, the CLI via the
workspace filesystem). A reference that fails to resolve at render time SHALL
degrade (a card in a missing/unavailable state), never fail the turn or crash
the host.

#### Scenario: A referenced file is gone at render time

- **GIVEN** a `data-file-reference` card naming `runs/run-abc/step-1/figures/volcano.png`
- **WHEN** the host resolves the path and the file does not exist
- **THEN** the host renders the card with that entry in a missing state
- **AND** no error is raised to the agent loop or the user's turn

### Requirement: show_user echart accepts an optional artifact data source

The `show_user` tool's `echart` kind SHALL accept an optional `dataPath`
field: an analysis-rooted artifact path naming a CSV that supplies the chart's
data. `dataPath` SHALL be validated with the same shape rules as `show_file`
paths (non-empty, ≤1024 chars, no NUL, no leading slash, no `..` segment); a
malformed path SHALL return the `{ shown: false, reason: "invalid_path" }`
data variant without emitting a card. The tool SHALL NOT check that the file
exists. When `dataPath` is provided the spec SHOULD omit `dataset.source` and
author `encode`/dimensions against the artifact's column names. The
deterministic presentation id SHALL cover `dataPath` (an identical re-emission
resolves to the same card).

#### Scenario: Agent charts an existing artifact

- **WHEN** the agent calls `show_user(kind: "echart", title: "DE genes", dataPath: "runs/run-abc/step-2/output/de-summary.csv")` with a spec encoding columns by name and no `dataset.source`
- **THEN** the tool emits a `data-presentation` card whose content carries the spec and `dataPath`
- **AND** returns `{ id }` with the id derived from the full input including `dataPath`

#### Scenario: Malformed dataPath

- **WHEN** the agent calls `show_user(kind: "echart", dataPath: "../outside.csv", ...)`
- **THEN** the tool returns `{ shown: false, reason: "invalid_path" }` and emits nothing

### Requirement: Hosts resolve dataPath under pinned CSV conventions

A host rendering an artifact-sourced echart card SHALL load the referenced
artifact at render time and inject its rows as the ECharts `dataset.source`.
The artifact contract is RFC-4180 CSV with a required header row; hosts SHALL
infer numeric columns and pass other columns through as strings. A missing or
unparseable artifact SHALL degrade to the card's missing/unavailable state
(never a crash); the embedded spec remains available for later re-resolution.

#### Scenario: Render-time data injection

- **GIVEN** a `data-presentation` echart card with `dataPath: "runs/run-abc/step-2/output/de-summary.csv"`
- **WHEN** a host renders the card
- **THEN** the host reads the CSV, treats the first row as the header, infers numeric columns, and injects the rows as `dataset.source` before rendering the spec

#### Scenario: Unparseable artifact degrades

- **WHEN** the referenced file is not parseable as header-rowed CSV
- **THEN** the host renders the card in a degraded state naming the path
- **AND** the turn and transcript are unaffected

