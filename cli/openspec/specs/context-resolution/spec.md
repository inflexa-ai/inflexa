# context-resolution Specification

## Purpose
Precedence-based resolution of what bare `inflexa` operates on (explicit flag → `.inflexa` marker walk-up → empty, with a copy guard), plus a human-readable one-line description printed before any action.

## Requirements

### Requirement: Resolve bare-inflexa context by precedence

The system SHALL provide `resolveContext(cwd, flags)` returning `Result<ResolvedContext, DbError>` in `src/modules/analysis/context.ts` that resolves what bare `inflexa` operates on, in precedence order: an explicit `flags.analysis` or `flags.project` wins outright; otherwise the nearest `.inflexa` marker at or above `cwd` determines an anchor and its analyses; otherwise the context is empty. `ResolvedContext` is a discriminated union with kinds `analysis`, `anchor`, `pick`, `empty`, and `copy`.

#### Scenario: Explicit analysis flag resolves to that analysis

- **WHEN** `resolveContext(cwd, { analysis: "<id-or-name>" })` matches an analysis
- **THEN** it returns `kind: "analysis"` with that analysis and its resolved `anchorPath`

#### Scenario: Explicit project flag yields a picker over its analyses

- **WHEN** `resolveContext(cwd, { project })` is called
- **THEN** it returns `kind: "pick"` over that project's analyses

#### Scenario: Unmatched analysis flag falls back to a picker

- **WHEN** `flags.analysis` is set but matches no analysis
- **THEN** it returns `kind: "pick"` over recent analyses (so the command can surface the mismatch)

#### Scenario: Marked folder with one analysis

- **WHEN** no flags are set and `cwd` (or an ancestor) has a marker with exactly one analysis
- **THEN** it returns `kind: "analysis"` for that analysis with the resolved `anchorPath`

#### Scenario: Marked folder with zero or many analyses

- **WHEN** no flags are set and the marked folder has zero or multiple analyses
- **THEN** it returns `kind: "anchor"` with the `anchorPath` and the list of analyses

#### Scenario: No marker yields empty

- **WHEN** no flags are set and there is no marker at or above `cwd`
- **THEN** it returns `kind: "empty"` with `cwd`

### Requirement: Copy guard during resolution

When resolving via a found marker, the system SHALL run `classifyMarkerSighting`; on a `"copy"` result it SHALL return `kind: "copy"` (carrying `cwd` and the marker) rather than resolving normally, so the command never auto-resolves a copied folder.

#### Scenario: Copied folder surfaces a copy context

- **WHEN** `cwd` holds a marker whose id belongs to a different, still-existing path
- **THEN** `resolveContext` returns `kind: "copy"` and does not resolve to an `analysis`/`anchor`

### Requirement: Human-readable context description

The system SHALL provide `describeContext(ctx)` returning a one-line summary suitable for printing before any action (loud, overridable context), with a distinct line for each `ResolvedContext` kind.

#### Scenario: Describe each kind

- **WHEN** `describeContext` is called on an `analysis` context
- **THEN** it returns a line naming the analysis and its anchor path
- **WHEN** called on an `anchor` context
- **THEN** it returns a line with the anchor path and analysis count

### Requirement: Library purity

`resolveContext` and `describeContext` SHALL return data/strings only — no printing, prompting, or `process.exit`. The picker and prompts are the presentation layer's responsibility.

#### Scenario: No side effects

- **WHEN** `resolveContext` resolves an ambiguous context
- **THEN** it returns `kind: "pick"` data without rendering a picker or prompting

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
