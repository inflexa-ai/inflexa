# Spec Delta

## MODIFIED Requirements

### Requirement: The tool is one call per operation, keyed by a session id

The tool input MUST be one of four operations: `start` (the source: a git URL with an optional ref, or a local folder), `exec` (a session id and one command), `commit` (a session id, the build script, and an optional package directory), and `stop` (a session id). Each operation is its own tool call. Thus the agent reads each result before it chooses the next command, and each `exec` carries its own approval.

A session MUST stay usable across the tool calls of the conversation until an operation ends it: `stop`, a completed `commit`, or the end of the host process. The tool description MUST tell the agent to stop the session when the build is done or the user refuses to continue. The tool description MUST also tell the agent that a denied call ran nothing and left the session open.

Two calls on one session MUST NOT overlap, in one model round or across turns. A call on a session waits until the earlier call on that session returned. Thus a plan restart never removes the container under a command of the same session.

The loop gets the approval of a call before the call waits for the earlier call. Thus each call MUST decide its ask again when it runs. If the call now needs a different ask than the ask that the user answered, the call MUST run nothing. It returns a stale-approval result that tells the agent to send the call again.

#### Scenario: The agent drives the session call by call

- **GIVEN** a started session
- **WHEN** the agent calls `exec` two times, then `commit`
- **THEN** each call returns its own result, and the session id of each call names the same live session

#### Scenario: A session ends at its stop

- **GIVEN** a started session
- **WHEN** the agent calls `stop`
- **THEN** the session id answers no later `exec`, and the host removed the container

#### Scenario: Two calls on one session run in sequence

- **GIVEN** two `install_from_source` calls on one session, from one round or from two turns
- **WHEN** both calls run
- **THEN** the second call starts only after the first call returned

#### Scenario: Calls on two sessions do not wait for each other

- **GIVEN** two calls on two different sessions
- **WHEN** both calls run
- **THEN** neither call waits for the other

#### Scenario: A call whose ask changed since its approval runs nothing

- **GIVEN** an exploration and one round with two `exec` calls, where the first call carries a plan and the second call carries none
- **WHEN** the second call gets no ask as an exploration read, and the first call binds its approved plan before the second call runs
- **THEN** the second call runs no command, and it returns a stale-approval result

### Requirement: The session explores before the plan ask

`start` MUST begin an exploration phase. For a git source, the session egress holds the host of the git source alone. The source is cloned at the pinned commit.

For a local folder, the session has no network, and the folder is copied in. The agent reads the repository through `exec` calls in this phase: the README, the file layout, and the build files. No build command runs.

Each `start` MUST ask the user before the host reads the source. The ask MUST show the source: the folder path, or the git URL and its ref. The ask of a folder MUST say that the session reads the whole folder. A denied start does not run, thus it MUST leave no session, no clone, and no copy.

The host MUST resolve the ref before the exploration. A named ref resolves to its commit, and an absent ref resolves to the head commit of the default branch. The commit in the plan and in the build record is the full commit sha that this resolution returned.

#### Scenario: The exploration reads the repository before any plan

- **GIVEN** a start of `https://github.com/tacazares/SeedMatchR` with no ref
- **WHEN** the exploration runs
- **THEN** the egress holds `github.com` alone, the tree is at the resolved head commit, and the agent execs read files and install nothing

#### Scenario: A folder source explores with no network

- **GIVEN** a start of a local folder that the user approves
- **WHEN** the exploration runs
- **THEN** the session egress names no host, and the agent reads the copied tree

#### Scenario: A folder start asks with the path

- **GIVEN** an agent that calls `start` with the folder `/Users/me/.ssh`
- **WHEN** the loop asks for the approval of the call
- **THEN** the ask shows `/Users/me/.ssh` before any read, and a denial leaves no session and no copy

#### Scenario: A git start asks with the URL

- **GIVEN** an agent that calls `start` with a git URL and a ref
- **WHEN** the loop asks for the approval of the call
- **THEN** the ask shows the URL and the ref before the clone, and a denial leaves no session

### Requirement: One ask approves the plan before any build command

After the exploration, the tool MUST ask one time before any build command runs. The first build command carries the plan, and its one ask holds the plan and the command. The ask says so when the command runs as root.

The ask holds the source (the git URL and its full commit sha, or the local folder), the host list of the session egress, the apt packages, and the build strategy. The host list of the ask MUST be the complete list that the session will carry. Thus the fixed hosts of the class show beside the hosts of the plan.

The tool MUST accept a plan host only when it is a DNS host name: two or more labels of letters, digits, and hyphens, a last label of letters alone, and no other character. The host of a git URL MUST obey the same rule, and the URL scheme MUST be `https` or `http`. The check ignores case, and the tool gives each host to the realization in lower case. A refused host fails the call before any ask, and the failure names the host.

An approval MUST move the session to the build phase under the approved egress list. The realization restarts the session container with the approved list. The source tree persists, thus the clone does not run again. A denied plan does not run, thus the session MUST stay in its phase under its earlier list, with no store change.

The grant key of a plan ask MUST hold the session id and a digest of the plan, the command, and the root mark. Thus an `always` answer on a plan ask approves that exact plan and command alone. It never approves a later amendment, and it never approves the other commands of the session.

A command that connects to a host outside the approved list MUST fail at the egress wall of the session. The tool MUST then be able to ask again with an amended plan that names the added hosts. An approval restarts the session under the amended list, exactly as the first approval did.

A restart keeps the scratch tree under `/work` alone. The tool description MUST tell the agent that a restart removes each change outside `/work`, for example the apt packages and the user libraries. The agent then installs them again.

#### Scenario: An approved plan moves the session to the build phase

- **GIVEN** an exploration and a plan ask that the user approves
- **WHEN** the call runs
- **THEN** the session runs under the approved host list, and the source tree is the tree the exploration read

#### Scenario: A rejected plan changes nothing

- **GIVEN** a plan ask that the user denies
- **WHEN** the loop denies the call
- **THEN** the command does not run, the session stays in its exploration phase, and the pool holds no new store directory

#### Scenario: An always answer on a plan approves no amendment

- **GIVEN** an `always` answer on the ask of a first build command and its plan
- **WHEN** a later call carries an amended plan
- **THEN** the ask of the amended plan has a different grant key, and the user answers it again

#### Scenario: A host outside the plan fails at the wall

- **GIVEN** a session whose approved list names no host H
- **WHEN** a session command connects to H
- **THEN** the command fails at the egress wall, and the failure names the wall

#### Scenario: An amended plan approves the wider list again

- **GIVEN** a wall failure for host H
- **WHEN** the tool asks again with a plan that adds H, and the user approves
- **THEN** the session restarts under the amended list, and a command to H no longer fails at the wall

#### Scenario: A top-level domain is not a host

- **GIVEN** a plan whose hosts hold `com`
- **WHEN** the agent sends the plan
- **THEN** the call fails before any ask, and the failure names `com`

#### Scenario: A host with a slash is not a host

- **GIVEN** a plan whose hosts hold `pypi.org/evil.example`
- **WHEN** the agent sends the plan
- **THEN** the call fails before any ask, and no wall receives the value

### Requirement: The commit ask shows the script and the record, then one clean run

Before the commit, the tool MUST ask one time. The ask shows the build script, the build record preview, and the package directory when the commit names one. An approval runs one clean run of the script in a new provisioner container over the pristine snapshot, and that run alone writes the store.

The grant key of a commit ask MUST hold the session id and a digest of the script, the package directory, and the hosts and apt packages of the plan. Thus an `always` answer never approves a different script, or the same script under a different plan.

The clean run installs the apt packages of the plan itself, and it runs the script as the non-root user with no capabilities. The tool description MUST tell the agent that the script installs no apt package and runs no command as root.

A failure of the clean run MUST return to the same session, because the session build used a state that the script does not make. The agent corrects the script there and starts the clean run again. A denied commit does not run, thus the session stays open with no store change.

#### Scenario: An approved commit runs the script once

- **GIVEN** a session whose build succeeded and whose commit ask the user approves
- **WHEN** the clean run executes
- **THEN** one new container runs the build script, and the artifact lands in the pool from that run alone

#### Scenario: A failed clean run returns to the session

- **GIVEN** a clean run that fails
- **WHEN** the failure returns to the agent
- **THEN** the same session stays open, and no store directory was written

#### Scenario: A rejected commit changes nothing

- **GIVEN** a commit ask that the user denies
- **WHEN** the loop denies the call
- **THEN** no clean run starts, the session stays open, and the pool holds no new store directory

#### Scenario: An always answer on a commit approves no other script

- **GIVEN** an `always` answer on a commit ask
- **WHEN** a later commit of the same session carries a different script
- **THEN** the later commit ask has a different grant key, and the user answers it again

### Requirement: A canceled turn stops the session work

The host MUST stop the work of a `start`, an `exec`, or a `commit` when the abort signal of the call fires. An aborted `exec` stops its command inside the session container. An aborted `commit` stops the clean-run container. An aborted `start` removes what the start made.

The call then fails, and the tool returns a failed result. The session of an aborted `exec` or `commit` stays open. An abort while the loop waits for the approval of a call also keeps the session open, because the call does not run.

#### Scenario: A cancel stops a long command

- **GIVEN** a session command that runs for many minutes
- **WHEN** the user cancels the turn
- **THEN** the command stops inside the container, and the tool call returns at once

#### Scenario: A cancel stops a clean run

- **GIVEN** a clean run in flight
- **WHEN** the user cancels the turn
- **THEN** the clean-run container stops, the tool call returns, and the pool holds no advertised node of the run

## ADDED Requirements

### Requirement: Each session command carries a session-scoped approval

In the build phase, the tool MUST ask one time per session command. The `always` answer MUST grant only within that session, through a grant key that holds the session id. That grant key MUST NOT answer a plan ask or a commit ask. An `exec` that the realization runs as root MUST say so in the ask.

A denied command does not run, and the session MUST stay open. The agent stops the session when the user refuses to continue. Only the clean run of the commit writes the store, thus a session that ends at any command leaves no store directory behind.

#### Scenario: Always applies to the session alone

- **GIVEN** an `always` answer on one command ask of a session
- **WHEN** the next command of the same session runs, and a later session starts
- **THEN** the next command of the same session runs with no ask, and the later session asks again

#### Scenario: A denied command leaves the session open with the store unchanged

- **GIVEN** a session whose command ask the user denies
- **WHEN** the loop denies the call
- **THEN** the command does not run, the session stays open, and the pool holds no new store directory

#### Scenario: A root command says so in its ask

- **GIVEN** an `exec` marked to run as root
- **WHEN** its ask renders
- **THEN** the ask states that the command runs as root

## REMOVED Requirements

### Requirement: Each session command carries a session-scoped ask

**Reason**: The tool no longer sees a rejection, thus a rejection cannot end the session.

**Migration**: The requirement "Each session command carries a session-scoped approval" replaces it. A denied command runs nothing, and the session stays open.
