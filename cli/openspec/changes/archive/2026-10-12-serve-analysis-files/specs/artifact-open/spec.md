## MODIFIED Requirements

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
