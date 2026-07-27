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

### Requirement: run_inflexa bounds a subprocess by silence, not by duration

`run_inflexa` SHALL bound a spawned command by how long it produces NO output,
rearming that bound whenever the child writes to either stream, and SHALL apply a
separate absolute ceiling independent of output. A wall-clock-only bound cannot
distinguish a command that is working from one that is wedged, so it either kills
legitimate long-running work or lets a hung command hold the turn for just as long;
bounding on silence separates the two. Output that arrives after the capture cap is
exhausted SHALL still count as activity — the bytes are discarded, but they are
evidence the child is alive. A bound that elapses SHALL be reported as a timeout, and
the caller's own cancellation SHALL remain distinguishable from either bound.

#### Scenario: A silent command is abandoned at the idle bound

- **GIVEN** a spawned command that produces no output
- **WHEN** the idle bound elapses
- **THEN** the command is terminated and reported as timed out, without waiting for the absolute ceiling

#### Scenario: A command that keeps reporting outlives the idle bound

- **GIVEN** a spawned command that produces output more often than the idle bound
- **WHEN** it runs for longer than that bound
- **THEN** it is allowed to continue and run to completion

#### Scenario: The absolute ceiling still bounds a command that never stops talking

- **GIVEN** a spawned command that produces output continuously and never exits
- **WHEN** the absolute ceiling elapses
- **THEN** the command is terminated and reported as timed out

#### Scenario: A caller cancellation is not reported as a timeout

- **GIVEN** a spawned command and a caller that aborts the turn
- **WHEN** the abort fires before either bound
- **THEN** the outcome is reported as cancelled, not as a timeout
