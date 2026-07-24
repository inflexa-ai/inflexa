## ADDED Requirements

### Requirement: run_inflexa injects the session analysis into the subprocess

When the conversation-agent session is analysis-scoped, `run_inflexa` SHALL inject
that analysis's id into the spawned subprocess environment (`INFLEXA_ANALYSIS`), so
an analysis-scoped command the agent runs without an explicit `--analysis` ref
operates on the chat's analysis. The id SHALL be read from the tool's session scope
(`ctx.session`), never from the model-supplied argv, so the agent cannot retarget a
different analysis by wording. When the session is not analysis-scoped, no analysis
value SHALL be injected. Injection SHALL be through the environment, not by
rewriting argv, so the approval prompt shows the exact command the model requested
and no command's commander parse is altered.

#### Scenario: An analysis-scoped session injects its analysis

- **GIVEN** an analysis-scoped agent session
- **WHEN** `run_inflexa` spawns an `inflexa` command
- **THEN** the child environment carries `INFLEXA_ANALYSIS` set to the session's analysis id

#### Scenario: The injected analysis comes from the session, not the argv

- **GIVEN** an analysis-scoped session
- **WHEN** the model supplies an argv that names no analysis
- **THEN** the injected `INFLEXA_ANALYSIS` is the session's analysis, and the argv is spawned unchanged

#### Scenario: A non-analysis session injects nothing

- **GIVEN** a session that is not analysis-scoped
- **WHEN** `run_inflexa` spawns an `inflexa` command
- **THEN** no analysis value is injected into the child environment
