## MODIFIED Requirements

### Requirement: Resolve bare-inflexa context by precedence

The system SHALL provide `resolveContext(cwd, flags)` returning `Result<ResolvedContext, DbError>` in `src/modules/analysis/context.ts` that resolves what bare `inflexa` operates on, in precedence order: an explicit `flags.analysis` or `flags.project` wins outright; otherwise an ambient analysis ref supplied by the caller (the `INFLEXA_ANALYSIS` environment value, read at the CLI boundary via `lib/env` — never inside this function, so it stays library-pure) resolves next; otherwise the nearest `.inflexa` marker at or above `cwd` determines an anchor and its analyses; otherwise the context is empty. `ResolvedContext` is a discriminated union with kinds `analysis`, `anchor`, `pick`, `empty`, and `copy`. The ambient ref sits below an explicit flag — so a command may always override it — and above the marker walk-up, so an agent-run command targets the chat's analysis regardless of the subprocess's working directory.

#### Scenario: Explicit analysis flag resolves to that analysis

- **WHEN** `resolveContext(cwd, { analysis: "<id-or-name>" })` matches an analysis
- **THEN** it returns `kind: "analysis"` with that analysis and its resolved `anchorPath`

#### Scenario: Explicit project flag yields a picker over its analyses

- **WHEN** `resolveContext(cwd, { project })` is called
- **THEN** it returns `kind: "pick"` over that project's analyses

#### Scenario: The ambient analysis ref resolves when no explicit flag is set

- **GIVEN** an ambient analysis ref (from `INFLEXA_ANALYSIS`) supplied by the boundary and no explicit `flags.analysis`/`flags.project`
- **WHEN** `resolveContext` runs and the ref matches an analysis
- **THEN** it returns `kind: "analysis"` for that analysis, without consulting the `.inflexa` marker

#### Scenario: An explicit flag overrides the ambient ref

- **GIVEN** both an explicit `flags.analysis` and an ambient ref
- **WHEN** `resolveContext` runs
- **THEN** the explicit flag determines the analysis and the ambient ref is not consulted

#### Scenario: Unmatched analysis flag falls back to a picker

- **WHEN** `flags.analysis` is set but matches no analysis
- **THEN** it returns `kind: "pick"` over recent analyses (so the command can surface the mismatch)

#### Scenario: Marked folder with one analysis

- **WHEN** no flags or ambient ref are set and `cwd` (or an ancestor) has a marker with exactly one analysis
- **THEN** it returns `kind: "analysis"` for that analysis with the resolved `anchorPath`

#### Scenario: Marked folder with zero or many analyses

- **WHEN** no flags or ambient ref are set and the marked folder has zero or multiple analyses
- **THEN** it returns `kind: "anchor"` with the `anchorPath` and the list of analyses

#### Scenario: No marker yields empty

- **WHEN** no flags or ambient ref are set and there is no marker at or above `cwd`
- **THEN** it returns `kind: "empty"` with `cwd`
