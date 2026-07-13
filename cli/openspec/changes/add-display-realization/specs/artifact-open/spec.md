# artifact-open — delta

## ADDED Requirements

### Requirement: One shared external-opener helper

The CLI SHALL provide a single shared helper that opens a file, directory, or
URL in the default OS application: platform-selected argv (`open` on darwin,
`xdg-open` on linux, `cmd /c start` on win32), spawned detached with output
ignored, returning `Result` (ENOENT and spawn failures on the error channel,
never thrown). Under WSL (detected once, e.g. `microsoft` in `/proc/version`)
the helper SHALL prefer `wslview` and fall back to `explorer.exe` with the
path translated via `wslpath -w`. The existing openers in `modules/auth/login.ts`
and `modules/analysis/open.ts` SHALL be replaced by this helper. A failed open
SHALL degrade to a notice carrying the resolved path — never a crash, never a
blocked turn.

#### Scenario: Opener binary missing

- **WHEN** the user opens a card on a headless box without `xdg-open`
- **THEN** a notice shows the resolved path for manual opening and the session continues

#### Scenario: WSL opens via Windows

- **GIVEN** the CLI runs under WSL
- **WHEN** the user opens an artifact
- **THEN** the helper spawns `wslview` (or `explorer.exe` with a `wslpath -w` translated path), not `xdg-open`

### Requirement: Openable cards resolve their reference at open time

Openable card parts SHALL store the semantic reference from the harness
contract (analysis-rooted paths, `previewId`/`previewPath`, the embedded
echart spec and `dataPath`, the deterministic `pres-` id) and SHALL NOT store
a resolved location. Resolution to an openable location happens when the user
opens: `data-file-reference` paths and `data-report-preview` previews resolve
against `resolveWorkspaceRoot(analysisId)`; `echart`/`svg` presentations
resolve to their materialized cache file. A reference that fails to resolve
(missing file, workspace desync) SHALL render that entry in a degraded state
with its path visible, and open attempts on it SHALL produce a notice — never
an error.

#### Scenario: Report preview opens in the browser

- **GIVEN** a `data-report-preview` card `{ previewId, previewPath: "v3/index.html" }`
- **WHEN** the user opens it
- **THEN** the CLI resolves `{workspaceRoot}/previews/{previewId}/v3/index.html` and opens it with the OS opener

#### Scenario: Referenced file is gone

- **WHEN** a `data-file-reference` entry's resolved path does not exist
- **THEN** the card renders that entry as missing with its path shown, and opening it produces a notice instead of an error

### Requirement: Presentations materialize into an id-keyed cache

`echart` and `svg` presentations SHALL materialize on demand into a CLI-owned
cache directory (app data, outside any analysis workspace), keyed by the
card's deterministic `pres-` id so re-emission and re-open are idempotent.
`svg` content materializes as an `.svg` file. `echart` content materializes as
a self-contained HTML shell embedding the spec and loading ECharts from a
pinned-major CDN URL, with a visible fallback notice when the script cannot
load (offline). For an artifact-sourced chart (`dataPath`), materialization
SHALL read the workspace CSV per the harness display-cards contract (RFC-4180,
header row, numeric column inference) and inject the rows as
`dataset.source`; a missing or unparseable CSV degrades the card, never
crashes. The cache is disposable: content is regenerable from the transcript.

#### Scenario: Chart opens interactively

- **WHEN** the user opens an `echart` presentation card
- **THEN** the CLI writes (or reuses) `<cache>/<pres-id>.html` and opens it in the browser, where the chart renders interactively

#### Scenario: Artifact-sourced chart carries its data

- **GIVEN** an echart card with `dataPath: "runs/run-abc/step-2/output/de-summary.csv"`
- **WHEN** the user opens it
- **THEN** the materialized HTML contains the CSV rows as `dataset.source` with the header row as dimension names

#### Scenario: Same card, same file

- **WHEN** the agent re-emits an identical presentation and the user opens it again
- **THEN** the same cache file is reused (no duplicate materializations)

### Requirement: Open UX — click, latest, and picker

Opening SHALL be reachable three ways: clicking an openable card opens that
card's content (a multi-file gallery opens the clicked row); the `o` binding
opens the most recent openable card in the transcript; a "Browse artifacts…"
command-palette entry opens a `SelectDialog` listing the session's openable
entries newest-first and opens the selection. The open commands SHALL be
registered as remappable command ids (`config.keybinds`). Multi-file
`data-file-reference` cards SHALL additionally offer opening the containing
folder. Every openable card SHALL display its resolved path so manual opening
is always possible.

#### Scenario: Open the latest

- **GIVEN** a turn where the agent just emitted a chart card
- **WHEN** the user presses `o`
- **THEN** the chart opens externally without any selection step

#### Scenario: Reach back via the picker

- **WHEN** the user runs "Browse artifacts…" from the command palette
- **THEN** a `SelectDialog` lists the session's openables newest-first and opens the chosen entry
