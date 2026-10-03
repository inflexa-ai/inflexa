## MODIFIED Requirements

### Requirement: The local server resolves the context of the folder of the client

A client MUST resolve its context through the resolve route of the local server. It MUST send the absolute path of its own working folder as `cwd`, with the optional analysis and project references of its flags. The server MUST run `resolveContext` with that `cwd`, never with the folder of its own process. The anchor reconciliation of the resolve MUST search for a moved folder from that `cwd`. A `cwd` that is not absolute MUST get 400 `validation_error`.

The answer MUST carry the resolved context and its `describeContext` line, so that the client prints the line before any action. A launch of the chat MUST ask for the anchor recovery under `cwd` first, which heals a moved anchor and creates nothing. A read command MUST ask the resolve to record no sighting of the anchor folder. A read is not a sighting, and an agent can run an `auto` command with no prompt. When an analysis reference matches more analyses by name, the answer MUST also carry the other candidates, so the client can report the collision.

The read of one analysis (`GET {A}`) MUST also take the folder of the client, as the `cwd` query value. The anchor reconciliation of that read MUST search for a moved folder from that `cwd`. A `cwd` that is not absolute MUST get 400 `validation_error`.

That read is an open of the analysis, thus it MUST record a sighting of the anchor folder. The query value `touch=false` MUST heal a moved folder with no sighting, for a read that is not an open, for example a poll. A sighting is a write of the anchor row. A `touch` value other than `true` or `false` MUST get 400 `validation_error`.

#### Scenario: A client in a different folder resolves its own folder

- **GIVEN** the local server runs with its working folder in the home folder of the user
- **WHEN** a client in a marked folder resolves with no flags
- **THEN** the server resolves the marker of the folder of the client, and the answer names the analysis of that folder

#### Scenario: A relative cwd is refused

- **WHEN** a client sends a `cwd` that is not absolute
- **THEN** the server answers 400 `validation_error` and resolves nothing

#### Scenario: A read command records no sighting

- **WHEN** `inflexa usage` resolves its analysis through the server
- **THEN** the resolve records no sighting of the anchor folder

#### Scenario: A name collision reaches the client

- **WHEN** a client resolves a name that two analyses share
- **THEN** the answer carries the newest one as the analysis and the other one as a candidate, and the client reports the ambiguity

#### Scenario: The read of an analysis heals from the folder of the client

- **GIVEN** an analysis whose folder moved to a folder under the working folder of the client
- **WHEN** the client reads the analysis with its `cwd`
- **THEN** the server finds the moved folder again from that `cwd`, and the answer names the new path

#### Scenario: A poll records no sighting

- **WHEN** the TUI reads the open analysis at a tick of its poll, with `touch=false`
- **THEN** the server records no sighting of the anchor folder
