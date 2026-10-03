# context-resolution Delta

## ADDED Requirements

### Requirement: The local server resolves the context of the folder of the client

A client SHALL resolve its context through the resolve route of the local server, and SHALL send the absolute path of its own working folder as `cwd`, with the optional analysis and project references of its flags. The server SHALL run `resolveContext` with that `cwd`, never with the folder of its own process, and the anchor reconciliation of the resolve SHALL search for a moved folder from that `cwd`. A `cwd` that is not absolute SHALL be refused with 400 `validation_error`.

The answer SHALL carry the resolved context and its `describeContext` line, so that the client prints the line before any action. A launch of the chat SHALL ask for the anchor recovery under `cwd` first, which heals a moved anchor and creates nothing. A read command SHALL ask the resolve to record no sighting of the anchor folder, because a read is not a sighting and an agent can run an `auto` command unprompted. When an analysis reference matches more analyses by name, the answer SHALL also carry the other candidates, so the client can report the collision.

The read of one analysis (`GET {A}`) SHALL also take the folder of the client, as the `cwd` query value. The anchor reconciliation of that read SHALL search for a moved folder from that `cwd`, and a `cwd` that is not absolute SHALL be refused with 400 `validation_error`.

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
- **THEN** the server re-finds the moved folder from that `cwd`, and the answer names the new path
