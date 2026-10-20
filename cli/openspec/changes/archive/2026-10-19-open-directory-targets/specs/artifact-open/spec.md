# Spec Delta

## MODIFIED Requirements

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
