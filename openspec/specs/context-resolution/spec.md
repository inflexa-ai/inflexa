# context-resolution Specification

## Purpose
Precedence-based resolution of what bare `inf` operates on (explicit flag → `.inf` marker walk-up → empty, with a copy guard), plus a human-readable one-line description printed before any action.
## Requirements
### Requirement: Resolve bare-inf context by precedence

The system SHALL provide `resolveContext(cwd, flags)` returning `Result<ResolvedContext, DbError>` in `src/modules/analysis/context.ts` that resolves what bare `inf` operates on, in precedence order: an explicit `flags.analysis` or `flags.project` wins outright; otherwise the nearest `.inf` marker at or above `cwd` determines an anchor and its analyses; otherwise the context is empty. `ResolvedContext` is a discriminated union with kinds `analysis`, `anchor`, `pick`, `empty`, and `copy`.

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

