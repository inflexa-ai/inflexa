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

### Requirement: run_inflexa reconciles inputs after a successful action

`run_inflexa` SHALL drive an input-parity reconciliation after a successful action,
because it runs inside the process that owns the harness runtime (the TUI) and is
therefore the only party that can safely stage and (re)profile after a subprocess
command mutates an analysis's input set. For a successful action run in an
analysis-scoped session, `run_inflexa` SHALL reconcile the session's
analysis through an injected host callback, so inputs a subprocess enrolled (which the
in-process event bus never delivered across the process boundary) are staged and
profiled under the already-booted runtime. The reconciliation SHALL be idempotent —
when the input set already matches the profile it SHALL be a no-op — and it SHALL run
only for a successful action, never for a blocked, denied, or introspection call.

#### Scenario: A successful input-mutating command triggers reconciliation

- **GIVEN** an analysis-scoped session and a successful `run_inflexa` action that enrolled a new input in a subprocess
- **WHEN** the tool returns success
- **THEN** it drives an input-parity reconciliation for the session's analysis under the host runtime

#### Scenario: Reconciliation is a no-op when nothing changed

- **GIVEN** a successful `run_inflexa` action that changed no inputs
- **WHEN** the reconciliation runs
- **THEN** the input set already matches the profile and no re-profile is started

#### Scenario: A denied or introspection call drives no reconciliation

- **GIVEN** a blocked or denied action, or an introspection call
- **WHEN** `run_inflexa` returns
- **THEN** it drives no reconciliation
