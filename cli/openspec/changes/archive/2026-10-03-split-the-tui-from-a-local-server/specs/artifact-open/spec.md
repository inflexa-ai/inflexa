## MODIFIED Requirements

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
