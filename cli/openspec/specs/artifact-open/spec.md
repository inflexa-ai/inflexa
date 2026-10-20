# artifact-open Specification

## Purpose
How the CLI opens a file, a folder, or a presentation that the agent shows to the user. A card keeps the semantic reference, and the local server resolves it to a location only when the user opens the card. One shared helper in the client process opens that location in the default application of the operating system.

## Requirements

### Requirement: One shared external-opener helper

The CLI MUST give one shared helper that opens a file, a folder, or a URL in the default application of the OS. The helper selects the argv for the platform: `open` on darwin, `xdg-open` on linux, and `cmd /c start` on win32. It starts the opener detached, and it ignores the output of the opener. It gives a `Result`, with `ENOENT` and each spawn failure on the error channel, and it never throws.

The helper detects WSL one time, for example from `microsoft` in `/proc/version`. Under WSL, the helper MUST use `wslview` first. When `wslview` is absent, it MUST use `explorer.exe` with the path that `wslpath -w` translates.

Each opener of the CLI MUST use this helper: the auth login, the `inflexa open` command, the open affordances of the TUI, and the folder open of the local server (`POST /api/v1/open-directory`). The helper MUST run in the client process, because the desktop of the user belongs to the client.

The folder open of the local server is the one exception. A browser page cannot open a folder. The server listens on the loopback address only, thus the desktop of the server is the desktop of the page. The folder open of the local server opens directories only, and the endpoint refuses a body that names a file.

In a client, a failed open MUST show a notice with the resolved path. It MUST NOT crash, and it MUST NOT block a turn. In the server, a failed open MUST give the answer `{ "opened": false }`.

#### Scenario: Opener binary missing

- **WHEN** the user opens a card on a headless machine with no `xdg-open`
- **THEN** a notice shows the resolved path for a manual open, and the session continues

#### Scenario: WSL opens via Windows

- **GIVEN** the CLI runs under WSL
- **WHEN** the user opens an artifact
- **THEN** the helper starts `wslview`, or `explorer.exe` with a path that `wslpath -w` translates, not `xdg-open`

#### Scenario: The server opens a folder for a page

- **WHEN** a browser page sends `POST /api/v1/open-directory` with `{ "target": "data_dir" }`
- **THEN** the local server opens the data folder through the shared helper
- **AND** a TUI open and an `inflexa open` still run the helper in their own process

### Requirement: Openable cards resolve their reference at open time

An openable card part MUST store the semantic reference of the harness contract. The reference is an analysis-rooted path, the embedded echart spec and `dataPath`, or the deterministic `pres-` id. A card part MUST NOT store a resolved location.

The local server resolves the reference when the user opens the card. The client sends the reference to `POST {A}/artifacts/resolve`. The server resolves it, and the client opens the path that the server gives.

- A `data-file-reference` path resolves against the workspace root of the analysis.
- An `echart` or `svg` presentation resolves to its file in the `presentations/` folder of the workspace. When the request asks to materialize, the server writes that file first.

A `data-file-reference` path that leaves the workspace MUST resolve nowhere and render degraded. A stored part that reloads from a persisted tool call skips the validation of the live tool.

For a `data-file-reference` path that exists, the server MUST also resolve each symbolic link. A real path outside the real path of the workspace root MUST resolve nowhere. The entry then renders degraded, the same as a path with a bad form. An agent can write a symbolic link in its step folder. A failure of this test MUST also resolve nowhere. A file or a folder whose real path is inside the workspace root resolves as before.

A reference that fails to resolve, for example a missing file or a workspace desync, MUST render degraded with its path visible. An open of such an entry MUST give a notice, never an error. A failed request to the server MUST also give a notice.

#### Scenario: Referenced file is gone

- **WHEN** a `data-file-reference` entry's resolved path does not exist
- **THEN** the card renders that entry as missing with its path shown, and opening it produces a notice instead of an error

#### Scenario: A path outside the workspace resolves nowhere

- **WHEN** a reloaded `data-file-reference` entry names `../../etc/passwd`
- **THEN** the server gives no path for it, the entry renders degraded, and an open produces a notice

#### Scenario: A symbolic link that leaves the workspace resolves nowhere

- **GIVEN** a symbolic link `runs/R/A/leak.txt` in the workspace, to a file outside the workspace
- **WHEN** a `data-file-reference` entry names `runs/R/A/leak.txt`
- **THEN** the server gives no path for it, the entry renders degraded, and an open produces a notice

#### Scenario: A folder inside the workspace still resolves

- **WHEN** an entry names the folder `runs/R/A/figures` of the workspace, to reveal it
- **THEN** the server gives the path of the folder

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
disposable: content is regenerable from the transcript. The server materializes
for a request, thus the directory creation and the file write SHALL run off the
event loop, so a workspace on a hung mount stops only that request.

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
