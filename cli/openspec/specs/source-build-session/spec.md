# source-build-session Specification

## Purpose

The `install_from_source` host tool of the CLI and the build session behind it. The tool lets an LLM build an R or a Python package from a git repository or a local folder. The CLI holds the provisioner container, channels the commands, walls the egress, and snapshots the source. The clean run flies into the package store through the same commit gate as an index acquisition.

## Requirements

### Requirement: The CLI binds the build session

The CLI MUST keep a `BuildSession` interface with the operations `start(source, analysisId, signal)`, `exec(handle, command, signal)`, `commit(handle, request, signal)`, and `stop(handle)`. The commit request holds the build script and an optional package directory. The signal is the abort signal of the turn that makes the call.

The realization of the interface owns the container runtime, the egress wall, and the store writes. The `install_from_source` tool drives the session call by call. The tool MUST NOT start a container, run a command, or write the store itself.

The tool reads the analysis id from the scope of its own conversation session, the same source that the farm-inventory readers use. `start` carries the analysis id, thus the commit extends the farm of the analysis that the conversation serves.

The CLI MUST give the tool to the conversation agent through the `hostTools` list of the conversation composition, exactly one time. The harness gives the host tools to the conversation agent alone. Thus no sandbox roster holds the tool, and an acquisition stays a host action. The tool MUST be absent when no container runtime is configurable. A boot with no working engine composes no conversation agent, thus no roster holds the tool.

#### Scenario: The tool is on the conversation roster once

- **GIVEN** a CLI session with a working container runtime
- **WHEN** the conversation agent is composed
- **THEN** the `hostTools` list holds `install_from_source`, and the roster holds exactly one `install_from_source` tool

#### Scenario: A boot with no engine composes no tool

- **GIVEN** a boot whose container runtime does not resolve
- **WHEN** the boot runs
- **THEN** the boot fails before the conversation composition, and no roster holds `install_from_source`

#### Scenario: Each long operation receives the signal of the turn

- **GIVEN** a bound `BuildSession`
- **WHEN** the tool calls `start`, `exec`, or `commit`
- **THEN** the call carries the abort signal of the tool context

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

### Requirement: The session works on its own copy of a pristine snapshot

The host MUST keep a pristine snapshot of the source that no session command writes. The snapshot is the clone at the resolved commit, or the copy of the folder. The session works on its own working copy. The clean run of the commit reads the pristine snapshot, thus the artifact always comes from the tree that the plan named. The tree hash of a folder source MUST be taken over the pristine copy before the first session command.

#### Scenario: The session never writes into the snapshot

- **GIVEN** a session whose build commands write into its working copy
- **WHEN** the commit starts the clean run
- **THEN** the clean run reads the pristine snapshot, which holds no build output of the session

#### Scenario: The tree hash precedes the session

- **GIVEN** a local folder source
- **WHEN** the session starts
- **THEN** the recorded tree hash is the hash of the pristine copy, computed before any session command

### Requirement: The session sees the source and no store

The session container MUST receive no store mount, because the session never reads or writes the pool. A private repository authenticates with the token that the host holds. The token MUST reach the clone command alone: no later `exec` environment, no tool result, no plan, and no build record holds it. The host MUST give the token only to a clone of an `https` URL whose host is `github.com`.

#### Scenario: The session container holds no store mount

- **WHEN** the session starts
- **THEN** the container has no `/mnt/libs` mount

#### Scenario: The token goes to the clone alone

- **GIVEN** a private git source on `github.com` and a host that holds the token
- **WHEN** the session explores
- **THEN** the environment of the clone command holds the token, and no later exec environment and no tool result holds it

#### Scenario: A different host gets no token

- **GIVEN** a git source on `gitlab.com` and a host that holds the token
- **WHEN** the clone runs
- **THEN** the clone runs with no credential

### Requirement: A session exec is a fresh shell keyed by the session

`exec` MUST run each command in a fresh shell. Its exec id MUST derive from the session id and a per-session sequence number. The chat path is not a durable step, thus no workflow id exists there. A `cd` or an `export` of one exec MUST NOT persist into the next. The tool description MUST tell the agent to use absolute paths or `cd <dir> && <command>`. The default working directory of a session MUST be the working-copy root.

The tool MUST return the whole combined output of the exec, and it MUST keep no output itself. A build log is longer than one excerpt. The loop of the harness cuts each result over the tool-result cap. It keeps the text of the result for `read_tool_output`, within the kept-text limit of the loop. The `harness-agent-loop` capability of the harness gives these rules.

#### Scenario: A directory change does not persist

- **GIVEN** a session whose first exec runs `cd /work/src` and whose second runs `pwd`
- **WHEN** both execs return
- **THEN** the second prints the working-copy root, not `/work/src`

#### Scenario: A long build log stays readable

- **GIVEN** a session exec whose output exceeds the tool-result cap
- **WHEN** the tool returns the result
- **THEN** the result holds the whole combined output, and the loop of the harness cuts it and keeps its text for `read_tool_output`

### Requirement: The identity and version come from the package metadata

For an R package, the name and the version MUST come from the `Package` and `Version` fields of its `DESCRIPTION`. For a Python package, they MUST come from the `.dist-info` of the built wheel. The tool MUST NOT ask the user for a version, because each ecosystem records its own.

#### Scenario: A fork keeps its DESCRIPTION identity

- **GIVEN** the repository `tacazares/SeedMatchR` at commit `2fc0c4f`, whose DESCRIPTION names `SeedMatchR` at `2.0.0`
- **WHEN** the source build commits
- **THEN** the stored package is `SeedMatchR` at `2.0.0`, whatever the name of the repository

### Requirement: The build strategy prefers the standard paths

The tool guidance MUST direct the agent to try the standard path first. For R, that is a pak lockfile resolve of the local source tree, which pulls the CRAN and Bioconductor dependencies. Custom steps come only when it fails. For Python, that is a wheel build of the tree and a hash-pinned resolve of the requirements of the wheel against the index. Then the wheel installs into the pool layout with no dependencies. The plan MUST state which strategy it proposes, and the guidance MUST live in the tool description that the CLI ships.

An R package whose `DESCRIPTION` is not at the root of the tree MUST name its directory in the `packageDir` field of the commit. The value is a relative path inside the tree, with no `..` segment. The clean run then resolves the dependencies from that directory.

#### Scenario: A pure R package needs no custom step

- **GIVEN** SeedMatchR, a pure R package whose imports CRAN serves
- **WHEN** the session builds it through the standard path
- **THEN** pak resolves and installs it, and the build script holds the standard steps alone

#### Scenario: An R package in a subdirectory names its directory

- **GIVEN** a repository whose R package lives under `pkg/`
- **WHEN** the agent commits with `packageDir` set to `pkg`
- **THEN** the clean run installs the dependencies that `pkg/DESCRIPTION` names before the script runs

#### Scenario: A package directory that leaves the tree is refused

- **GIVEN** a commit whose `packageDir` is `../other`
- **WHEN** the tool reads the input
- **THEN** the call fails before the commit ask

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

### Requirement: A lost session costs no store state

The session is not durable. If the host process stops, the session is lost and its scratch volume is debris. The store MUST stay sound, because only the clean run writes it. A clean run that stops mid-flight leaves staging, and the repair step of the next provisioner run removes it.

#### Scenario: A stopped host loses the session alone

- **GIVEN** a live session whose host process stops
- **WHEN** the next provisioner run starts
- **THEN** the repair step clears the abandoned staging, and `deps.json` and each farm are unchanged

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

### Requirement: A session is a held container with the wall installed at start

A walled session MUST run as two held containers of the provisioner image. The wall container applies the egress allowlist of the session, with the same allowlist function that the provisioner entrypoint uses, and then holds. Only the wall container MUST hold `NET_ADMIN`, and it MUST have no mount.

The session container MUST join the network namespace of the wall container, and it MUST resolve names through the resolver of the wall. The session container MUST NOT hold `NET_ADMIN`. It MUST drop each capability except the set that a root package install uses: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`, `SETUID`, `SETGID`, and `KILL`. It MUST set `no-new-privileges`.

The session container MUST take the CPU and memory ceilings of one sandbox step from the resource policy of the CLI. Its swap MUST NOT pass the memory ceiling. It MUST also take a process limit. A folder exploration has no wall container, and its session container has no network, with the same capability and resource rules.

A move to the build phase, or an amended plan, MUST restart the containers under the new approved list over the same scratch volume. Thus the wall always matches the approved hosts.

Each start MUST first remove a container that holds the name of the session container or of its wall container. A start that fails after a container exists MUST remove that container. Thus a retry under the same names never fails on a name conflict.

The session container MUST receive no store mount at `/mnt/libs`. It receives one scratch volume for the pristine snapshot and the working copy, and the pristine snapshot is mounted read-only inside the session. The host directory of the scratch volume MUST sit inside a parent directory that only the host user can open. For a folder source, it receives no bind of the original folder, because the host copies the folder in.

The host MUST remove each container of the session when the session ends. A container whose host process died MUST be removable as debris.

#### Scenario: The session container holds no store bind

- **WHEN** the session container starts
- **THEN** its mounts hold the scratch volume alone, and no `/mnt/libs` mount

#### Scenario: The pristine snapshot is read-only in the session

- **GIVEN** a session whose build commands write into its working copy
- **WHEN** a command of any user writes into the pristine snapshot path
- **THEN** the write fails, and the clean run still reads the untouched snapshot

#### Scenario: The exploration wall holds the git host alone

- **GIVEN** a start of a GitHub source
- **WHEN** the exploration containers start
- **THEN** the egress variable of the wall container holds the git host of the source and no other host

#### Scenario: An approval restarts the container under the approved list

- **GIVEN** an approved plan whose host list names the snapshot host, the index, and the pak repositories
- **WHEN** the session moves to the build phase
- **THEN** the new wall container carries the approved list, and the pristine snapshot is the same tree

#### Scenario: A root command cannot delete the wall

- **GIVEN** a walled session and an approved root command `nft delete table ip inflexa-egress`
- **WHEN** the command runs
- **THEN** the command fails with a permission error, and the wall stays

#### Scenario: The session container carries the limits

- **WHEN** the session container starts
- **THEN** its arguments drop each capability outside the install set, set `no-new-privileges`, and carry the CPU, memory, swap, and process limits

#### Scenario: A failed start leaves no container behind

- **GIVEN** a restart whose container starts but whose wall never reports itself active
- **WHEN** the restart fails, and the next exec retries it
- **THEN** the retry removes the old containers first, and the start does not fail on a name conflict

### Requirement: Each command runs as one exec with a timeout and a user rule

Each command MUST arrive through the exec channel of the container runtime with its own timeout, and each exec MUST start a fresh shell. An exec MUST run as the non-root user of the image by default. The tool can mark one exec as root, and the ask of a root exec MUST say so. A command that outlives its timeout MUST be killed and reported as timed out.

The host MUST keep at most 1 MiB of each output stream of an exec: the first half and the last half of that budget. A marker between the two halves MUST name the count of the bytes that the host dropped. The host MUST read each stream to its end, so that a long output never blocks the command.

When the abort signal of the call fires, the host MUST stop the command inside the session container. The command then ends within the kill grace of its timeout, and the call fails with the abort.

#### Scenario: Each command runs in a fresh shell with a timeout

- **GIVEN** a session and two commands
- **WHEN** the realization executes them
- **THEN** each runs through its own exec with its own timeout, and one command outliving its timeout is killed and reported as timed out

#### Scenario: A build command runs as the non-root user

- **GIVEN** a build command that the tool does not mark as root
- **WHEN** the realization executes it
- **THEN** it runs as the non-root user of the image

#### Scenario: A large output keeps its head and its tail

- **GIVEN** a command that writes 5 MiB to its standard output
- **WHEN** the exec returns
- **THEN** the result holds the first and the last part of the output within 1 MiB, and a marker names the dropped byte count

#### Scenario: An abort stops the command in the container

- **GIVEN** a command that sleeps for ten minutes
- **WHEN** the abort signal fires
- **THEN** the host sends the stop to the command inside the container, and the exec call fails with the abort

### Requirement: The session egress is a class of its own

The session egress allowlist MUST hold, beside the two acquisition classes, the host of the git source, the hosts of its submodules, the dated Ubuntu snapshot host for apt, and the Python index and the pak repositories for build dependencies. The exploration phase holds the git host alone. The plan MUST name each host of the build phase, and the host list the plan ask shows MUST be the complete list the session will carry — the hosts the plan adds beside the index and pak hosts of the class — because the user approves exactly what the wall will allow. The user approves the list before any build command. An `acquire` flight MUST NOT gain a host of this class, and a session MUST NOT gain a host of the acquisition classes beyond the index and pak entries.

#### Scenario: The plan ask shows the complete list

- **GIVEN** a plan whose source is `github.com` and whose apt snapshot is `snapshot.ubuntu.com`
- **WHEN** the plan ask renders and the build-phase container starts
- **THEN** the ask shows the same complete list the container env carries, hosts of the plan and fixed hosts of the class together

#### Scenario: The acquisition classes stay two

- **WHEN** an `acquire` flight launches the provisioner
- **THEN** its egress variable holds the index hosts and the pak repositories only

### Requirement: The host snapshots the source before the session commands

For a git source, the host MUST clone the repository at the resolved commit into the pristine snapshot, before the first session command. The session MUST NOT clone again.

For a local folder, the host MUST copy the folder into the pristine snapshot before the first session command. It MUST hash that copy with the tree hash of the provisioner. The copy MUST NOT block the event loop of the host process. The copy MUST refuse a relative path, a FIFO, a socket, and a device file. It MUST refuse a tree whose files hold more than 2 GiB, and a tree of more than 200000 entries. The copy MUST read each file through a handle that it opened with no link follow and no block. It MUST make sure that the handle is a regular file. It MUST count the bytes that it reads against the limit. A refused copy MUST leave no partial snapshot. When the abort signal fires, the copy MUST stop and remove the partial snapshot. The copy MUST keep a symbolic link as a link and never follow it. The copy MUST make each directory and each file readable by each user, and it MUST keep the executable bit of each file.

The session works on a working copy, and the clean run reads the pristine snapshot alone.

A private repository authenticates with the token that the host environment holds under `GITHUB_PAT`. The host MUST give the token only to a clone of an `https` URL whose host is `github.com`. Each other source MUST clone with no credential. The token MUST reach the clone steps alone: no later exec environment, the plan, the build record, or any flight row holds it.

#### Scenario: The clone lands at the resolved commit

- **GIVEN** the source `https://github.com/tacazares/SeedMatchR` resolved to commit `2fc0c4f`
- **WHEN** the session starts
- **THEN** the pristine snapshot holds the tree at `2fc0c4f`, and the session needs no clone step

#### Scenario: The folder hash precedes the session and covers the copy

- **GIVEN** a local folder source
- **WHEN** the session starts
- **THEN** the recorded tree hash is the hash of the pristine copy, computed before any command, and the original folder is never mounted

#### Scenario: A folder larger than the limit is refused

- **GIVEN** a folder whose files hold more than 2 GiB
- **WHEN** the session starts
- **THEN** the start fails, the failure names the limit, and no snapshot remains

#### Scenario: A FIFO in the folder is refused

- **GIVEN** a folder that holds a FIFO
- **WHEN** the session starts
- **THEN** the start fails and names the FIFO, and the host never opens it

#### Scenario: The token rides the clone alone

- **GIVEN** a private git source on `https://github.com` and a host that holds `GITHUB_PAT`
- **WHEN** the clone runs
- **THEN** the clone steps can read the token, and no later exec environment holds it

#### Scenario: Another host clones with no token

- **GIVEN** a source on `https://gitlab.com` and a host that holds `GITHUB_PAT`
- **WHEN** the clone runs
- **THEN** no askpass helper exists, and the clone holds no credential

#### Scenario: A plain http GitHub URL gets no token

- **GIVEN** a source on `http://github.com` and a host that holds `GITHUB_PAT`
- **WHEN** the clone runs
- **THEN** the clone holds no credential

### Requirement: The clean run flies through the store flight tail

The commit of a session MUST launch one `acquire-source` provisioner run. The run takes the pristine snapshot and the approved build script, with the session egress class and the image digests in its environment. The run writes the artifact into the pool and stages the graph nodes as one report.

The host MUST write the approved script into a host directory of its own, which no session container mounts. The host MUST make a new file, and never open an existing path, and it MUST bind the file read-only into the clean run. The host MUST remove the directory after the flight. The clean run MUST also receive a read-only view of the store beside the read-write mount, for the dependency library of the script.

The flight MUST then run the unchanged tail. The tail is the load check inside the sandbox image with the link rule, the graph commit under the metadata lock, and the farm extension. The tool carries the analysis id of its session scope into `start`, and the commit extends that analysis. A binding that answers no analysis is a binding fault, not a mode.

The source flight row MUST be created at the clean run, keyed by the qualified pin. The row MUST be claimed before the run launches, so a reclamation sees the live work. A failed check or commit MUST leave no advertised state. It MUST settle as a terminal `failed` flight row whose phase names where it stopped, as an index acquisition does.

A farm-extension failure MUST NOT fail the flight, exactly as an index acquisition. The packages are in the pool and the graph, and a later link extends the farm. The retry route of the flight surfaces MUST refuse a source row. A source build starts again through the tool, not through an index `store add`.

The flight MUST remove the report file of the run on each path after the run: a refused run, a failed check, a failed commit, and a success.

When the abort signal of the commit fires, the host MUST remove the clean-run container, and the flight MUST settle as `failed`. This holds also when the signal fires during the load check: the graph commit then does not run.

#### Scenario: A green clean run lands in pool and farm

- **GIVEN** an approved build script whose clean run succeeds and whose load check passes
- **WHEN** the flight completes
- **THEN** the graph holds the new node, and the farm of the subscribed analysis links it

#### Scenario: A red link rule advertises nothing

- **GIVEN** a source-built package whose artifact links a library the sandbox image does not carry
- **WHEN** the flight runs the load check
- **THEN** no node commits, no farm links it, and the failed row carries the named library

#### Scenario: The retry route refuses a source row

- **GIVEN** a `failed` flight row keyed by a qualified pin
- **WHEN** a surface offers its retry action
- **THEN** the action refuses with the direction to start the source build again through the tool

#### Scenario: A planted link cannot redirect the script write

- **GIVEN** a session command that made `/work/build.sh` a symbolic link to a host file
- **WHEN** the commit writes the approved script
- **THEN** the host file is unchanged, and the clean run reads the approved bytes

#### Scenario: A refused run leaves no report file

- **GIVEN** a clean run whose script fails
- **WHEN** the flight settles
- **THEN** the `source-*.json` report of the run is gone

#### Scenario: An abort removes the clean-run container

- **GIVEN** a clean run in flight
- **WHEN** the abort signal of the commit fires
- **THEN** the host removes the clean-run container, and the flight row settles as `failed`

### Requirement: The farm lock reads the source from the build record

When the composition links a source-built store directory, its lock entry MUST carry a `source` field read from the build record beside the pin marker: the URL and the full commit sha, or the tree hash of the folder, with the qualified pin. A source-built R package MUST link under the `r/source` subtree of the farm. The composition MUST refuse two store directories of one package name in one farm — the Python link pass through the existing version-collision check, and the R link pass through the same refusal, which today skips an occupied link in silence. A pool query that two directories of one identity answer MUST refuse with both directories named, whether the query pins the version or takes the newest, on the store-link path and the farm-extension seam alike, because a silent pick of the head would serve the fork to a caller that named neither build.

#### Scenario: The lock entry carries the source

- **GIVEN** a farm extension that links the source-built SeedMatchR
- **WHEN** the new lock is written
- **THEN** its entry carries the URL, the commit, and the qualified pin, and the package links under `r/source`

#### Scenario: A fork and an index package never share a farm

- **GIVEN** a farm that links the CRAN `SeedMatchR==2.0.0` and a request to link the source-built `SeedMatchR==2.0.0@git:<sha>`
- **WHEN** the composition runs
- **THEN** it refuses, and the message names both store directories

#### Scenario: A version two directories answer refuses

- **GIVEN** a pool that holds the CRAN `SeedMatchR==2.0.0` and the source-built `SeedMatchR==2.0.0@git:<sha>`
- **WHEN** a link asks for `r:SeedMatchR==2.0.0` or for `r:SeedMatchR`
- **THEN** the answer refuses with both store directories named, and neither is linked in silence
