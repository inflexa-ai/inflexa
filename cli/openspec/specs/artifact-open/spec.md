# artifact-open Specification

## Purpose
How the CLI opens a file, a folder, or a presentation that the agent shows to the user. A card keeps the semantic reference, and the local server resolves it to a location only when the user opens the card. One shared helper in the client process opens that location in the default application of the operating system.

## Requirements

### Requirement: One shared external-opener helper

The CLI SHALL provide a single shared helper that opens a file, directory, or
URL in the default OS application: platform-selected argv (`open` on darwin,
`xdg-open` on linux, `cmd /c start` on win32), spawned detached with output
ignored, returning `Result` (ENOENT and spawn failures on the error channel,
never thrown). Under WSL (detected once, e.g. `microsoft` in `/proc/version`)
the helper SHALL prefer `wslview` and fall back to `explorer.exe` with the
path translated via `wslpath -w`. Each opener of the CLI SHALL use this
helper: the auth login, the `inflexa open` command, and the open affordances
of the TUI. The helper SHALL run in the client process, never in the local
server, because the desktop of the user belongs to the client. A failed open
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
contract (analysis-rooted paths, the embedded
echart spec and `dataPath`, the deterministic `pres-` id) and SHALL NOT store
a resolved location. Resolution to an openable location happens when the user
opens, in the local server: the client sends the reference to
`POST {A}/artifacts/resolve`, the server resolves it, and the client opens the
path that the server gives. `data-file-reference` paths resolve
against the workspace root of the analysis; `echart`/`svg` presentations
resolve to their materialized file under the workspace's `presentations/`
directory, which the server writes first when the request asks to
materialize. A `data-file-reference` path that leaves the workspace SHALL
resolve nowhere and render degraded, because a stored part that reloads from
a persisted tool call skips the validation of the live tool. A reference that
fails to resolve (missing file, workspace desync) SHALL render that entry in a
degraded state with its path visible, and open attempts on it SHALL produce a
notice — never an error. A failed request to the server SHALL also produce a
notice.

#### Scenario: Referenced file is gone

- **WHEN** a `data-file-reference` entry's resolved path does not exist
- **THEN** the card renders that entry as missing with its path shown, and opening it produces a notice instead of an error

#### Scenario: A path outside the workspace resolves nowhere

- **WHEN** a reloaded `data-file-reference` entry names `../../etc/passwd`
- **THEN** the server gives no path for it, the entry renders degraded, and an open produces a notice

### Requirement: Presentations materialize into the workspace presentations directory

`echart` and `svg` presentations SHALL materialize on demand into the analysis
workspace's reserved `presentations/` directory
(`{workspaceRoot}/presentations/`, a root-level sibling of `data/`, `runs/`,
and `reports/`), keyed by the card's deterministic `pres-` id so
re-emission and re-open are idempotent. `svg` content materializes as an
`.svg` file. `echart` content materializes as a self-contained HTML shell
embedding the spec and loading ECharts from a pinned-major CDN URL, with a
visible fallback notice when the script cannot load (offline). For an
artifact-sourced chart (`dataPath`), the shell SHALL NOT embed the data: it
references the artifact by a URL relative to where the shell sits
(`../{dataPath}`) and fetches it at render time, parsing it in-page with a
pinned-major CDN CSV parser (PapaParse: delimiter auto-detection, numeric
cell typing, header row first) into `dataset.source`, so an open always
reflects the current artifact bytes. A failed fetch or parse degrades to a
visible in-page note, never a crash; an invalid `dataPath` shape is refused
before a URL is derived and pre-degrades the shell. Materialized files are
disposable: content is regenerable from the transcript.

#### Scenario: Chart opens interactively

- **WHEN** the user opens an `echart` presentation card
- **THEN** the CLI writes (or reuses) `{workspaceRoot}/presentations/<pres-id>.html` and opens it in the browser, where the chart renders interactively

#### Scenario: Artifact-sourced chart imports its data

- **GIVEN** an echart card with `dataPath: "runs/run-abc/step-2/output/de-summary.csv"`
- **WHEN** the user opens it
- **THEN** the materialized HTML references `../runs/run-abc/step-2/output/de-summary.csv` and loads it as `dataset.source` at render time — the CSV rows are never written into the shell

#### Scenario: Same card, same file

- **WHEN** the agent re-emits an identical presentation and the user opens it again
- **THEN** the same presentations file is reused (no duplicate materializations)

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
