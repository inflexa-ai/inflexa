## ADDED Requirements

### Requirement: run_inflexa runs the child in the session analysis's folder

When the conversation-agent session is analysis-scoped, `run_inflexa` SHALL spawn
the subprocess with its working directory set to the folder that analysis lives
in, so a command that resolves its target from the working directory operates on
the chat's analysis rather than on whatever directory the host process happens to
have been started in — the two differ after a resume, an explicit-reference
launch, or a mid-session analysis swap. The folder SHALL be derived from the
tool's session scope, never from the model-supplied argv, so the agent cannot
retarget another analysis by wording. When the session is not analysis-scoped, or
the folder cannot be located, the child SHALL inherit the host process's working
directory: an unlocatable folder is routine desync between the database and the
filesystem, never a reason to refuse a command that would otherwise run.

#### Scenario: An analysis-scoped session runs the child in that analysis's folder

- **GIVEN** an analysis-scoped agent session
- **WHEN** `run_inflexa` spawns an `inflexa` command
- **THEN** the child's working directory is the folder that analysis lives in

#### Scenario: The folder comes from the session, not the argv

- **GIVEN** an analysis-scoped session and an argv naming a different analysis
- **WHEN** `run_inflexa` spawns the command
- **THEN** the working directory is still the session analysis's folder

#### Scenario: A non-analysis session inherits the host's directory

- **GIVEN** a session that is not analysis-scoped
- **WHEN** `run_inflexa` spawns an `inflexa` command
- **THEN** the child inherits the host process's working directory

#### Scenario: An unlocatable folder does not fail the command

- **GIVEN** an analysis-scoped session whose analysis or folder can no longer be located
- **WHEN** `run_inflexa` spawns the command
- **THEN** the child inherits the host process's working directory and the command runs

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
