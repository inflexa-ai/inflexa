# source-build-session Specification

## Purpose

The harness interface and the conversation tool that let an LLM build an R or a Python package from a git repository or a local folder, inside a provisioner session, and land it in the package store through the same commit gate as an index acquisition.

## Requirements

### Requirement: The build session is an embedder-bound interface

The harness MUST expose a `BuildSession` interface with the operations `start(source, analysisId)`, `exec(handle, command)`, `commit(handle, script)`, and `stop(handle)`. The tool reads the analysis id from the scope of its own conversation session — the same source the farm-inventory readers use — and `start` carries it, thus the commit extends the farm of the analysis the conversation serves. The interface MUST NOT let the harness start a container, run a command, or write the store itself: the embedder owns the container runtime, the egress wall, and the store writes. The conversation tool `install_from_source` MUST join the conversation roster only when the composition binds the interface, in the same pattern as `link_packages` and the farm-extension interface. The tool MUST NOT join any sandbox-agent roster, because an acquisition stays a host action.

#### Scenario: An unbound interface leaves the tool off the roster

- **GIVEN** a composition that binds no `BuildSession`
- **WHEN** the conversation agent is composed
- **THEN** the roster holds no `install_from_source` tool

#### Scenario: A bound interface adds the tool to the conversation alone

- **GIVEN** a composition that binds a `BuildSession`
- **WHEN** the conversation agent and a sandbox agent are composed
- **THEN** the conversation roster holds `install_from_source`, and the sandbox roster holds none

### Requirement: The tool is one call per operation, keyed by a session id

The tool input MUST be one of four operations: `start` (the source: a git URL with an optional ref, or a local folder), `exec` (a session id and one command), `commit` (a session id and the build script), and `stop` (a session id). Each operation is its own tool call, thus the agent reads each result before it chooses the next command, and each `exec` carries its own approval. A session MUST stay usable across the tool calls of the conversation until an operation ends it: `stop`, a completed `commit`, or the end of the host process. The tool description MUST tell the agent to stop the session when the build is done or the user refuses to continue.

#### Scenario: The agent drives the session call by call

- **GIVEN** a started session
- **WHEN** the agent calls `exec` twice, then `commit`
- **THEN** each call returns its own result, and the session id of each call names the same live session

#### Scenario: A session ends at its stop

- **GIVEN** a started session
- **WHEN** the agent calls `stop`
- **THEN** the session id answers no later `exec`, and the embedder removed the container

### Requirement: The session explores before the plan ask

`start` MUST begin an exploration phase: a session container whose egress holds the host of the git source alone (and the read-only view of a local folder, which needs no egress), with the source cloned at the pinned commit or the folder copied in. The agent reads the repository through `exec` calls in this phase — the README, the file layout, and the build files — and no build command runs. The host MUST resolve the ref before the exploration: a named ref resolves to its commit, and an absent ref resolves to the head commit of the default branch. The commit in the plan and in the build record is the full commit sha that this resolution returned.

#### Scenario: The exploration reads the repository before any plan

- **GIVEN** a start of `https://github.com/tacazares/SeedMatchR` with no ref
- **WHEN** the exploration runs
- **THEN** the egress holds `github.com` alone, the tree sits at the resolved head commit, and the agent's exec calls read files and install nothing

#### Scenario: A folder source explores with no network

- **GIVEN** a start of a local folder
- **WHEN** the exploration runs
- **THEN** the session egress names no host, and the agent reads the copied tree

### Requirement: One ask approves the plan before any build command

After the exploration, the tool MUST ask once, before any build command runs, with the source (the git URL and its full commit sha, or the local folder), the host list of the session egress (the apt snapshot host beside the source host, the Python index, and the pak repositories), the apt packages, and the build strategy. The host list the ask shows MUST be the complete list the session will carry, thus the embedder's plan fields name every host of the class, the fixed hosts beside the added ones. An approval MUST move the session to the build phase under the approved egress list — the realization restarts the session container with the approved list, and the source tree persists, thus the clone does not repeat. A rejection MUST end the session with no store change.

A command that connects to a host outside the approved list MUST fail at the egress wall of the session. The tool MUST then be able to ask again with an amended plan that names the added hosts, and an approval restarts the session under the amended list, exactly as the first approval did.

#### Scenario: An approved plan moves the session to the build phase

- **GIVEN** an exploration and a plan ask that the user approves
- **WHEN** the ask resolves
- **THEN** the session runs under the approved host list, and the source tree is the tree the exploration read

#### Scenario: A rejected plan changes nothing

- **GIVEN** a plan ask that the user rejects
- **WHEN** the ask throws
- **THEN** no session exists, and the pool holds no new store directory

#### Scenario: A host outside the plan fails at the wall

- **GIVEN** a session whose approved list names no host H
- **WHEN** a session command connects to H
- **THEN** the command fails at the egress wall, and the failure names the wall

#### Scenario: An amended plan re-approves the wider list

- **GIVEN** a wall failure for host H
- **WHEN** the tool asks again with a plan that adds H, and the user approves
- **THEN** the session restarts under the amended list, and a command to H no longer fails at the wall

### Requirement: Each session command carries a session-scoped ask

In the build phase, the tool MUST ask once per session command, and the `always` answer MUST grant only within that session, through a grant key that holds the session id. An `exec` that the realization runs as root MUST say so in the ask. A rejection of a command ask MUST end the session. Only the clean run of the commit writes the store, thus a session that ends at any command leaves no store directory behind.

#### Scenario: Always applies to the session alone

- **GIVEN** an `always` answer on one command ask of a session
- **WHEN** the next command of the same session runs, and a later session starts
- **THEN** the next command of the same session runs with no ask, and the later session asks again

#### Scenario: A rejected command ends the session with the store unchanged

- **GIVEN** a session whose command ask the user rejects
- **WHEN** the ask throws
- **THEN** the session stops, and the pool holds no new store directory

#### Scenario: A root command says so in its ask

- **GIVEN** an `exec` marked to run as root
- **WHEN** its ask renders
- **THEN** the ask states that the command runs as root

### Requirement: The session works on its own copy of a pristine snapshot

The embedder MUST keep a pristine snapshot of the source — the clone at the resolved commit, or the copy of the folder — that no session command writes. The session works on its own working copy, and the clean run of the commit reads the pristine snapshot, thus the artifact always comes from the tree the plan named. The tree hash of a folder source MUST be taken over the pristine copy before the first session command.

#### Scenario: The session never dirties the snapshot

- **GIVEN** a session whose build commands write into its working copy
- **WHEN** the commit starts the clean run
- **THEN** the clean run reads the pristine snapshot, which holds no build output of the session

#### Scenario: The tree hash precedes the session

- **GIVEN** a local folder source
- **WHEN** the session starts
- **THEN** the recorded tree hash is the hash of the pristine copy, computed before any session command

### Requirement: The session sees the source and no store

The session container MUST receive no store mount, because the session never reads or writes the pool. A private repository authenticates with the token the host holds, and the token MUST reach the clone command alone: no later `exec` environment, no tool result, no plan, and no build record holds it.

#### Scenario: The session container holds no store mount

- **WHEN** the session starts
- **THEN** the container has no `/mnt/libs` mount

#### Scenario: The token rides the clone alone

- **GIVEN** a private git source and a host that holds the token
- **WHEN** the session explores
- **THEN** the clone command's environment holds the token, and no later exec environment and no tool result holds it

### Requirement: A session exec is a fresh shell keyed by the session

`exec` MUST run each command in a fresh shell, and its exec id MUST derive from the session id and a per-session sequence number, because the chat path is not a durable step and no workflow id exists there. A `cd` or an `export` of one exec MUST NOT persist into the next, and the tool description MUST tell the agent to use absolute paths or `cd <dir> && <command>`. The default working directory of a session MUST be the working-copy root. The result text MUST obey the tool-result cap of the loop, and the whole text MUST stay readable through `read_tool_output`, because a build log is longer than one excerpt.

#### Scenario: A directory change does not persist

- **GIVEN** a session whose first exec runs `cd /work/src` and whose second runs `pwd`
- **WHEN** both execs return
- **THEN** the second prints the working-copy root, not `/work/src`

#### Scenario: A long build log stays readable

- **GIVEN** a session exec whose output exceeds the tool-result cap
- **WHEN** the result returns to the agent
- **THEN** the agent reads the excerpt, and a kept reference serves the whole text through `read_tool_output`

### Requirement: The identity and version come from the package metadata

For an R package, the name and the version MUST come from the `Package` and `Version` fields of its `DESCRIPTION`. For a Python package, they MUST come from the `.dist-info` of the built wheel. The tool MUST NOT ask the user for a version, because each ecosystem records its own.

#### Scenario: A fork keeps its DESCRIPTION identity

- **GIVEN** the repository `tacazares/SeedMatchR` at commit `2fc0c4f`, whose DESCRIPTION names `SeedMatchR` at `2.0.0`
- **WHEN** the source build commits
- **THEN** the stored package is `SeedMatchR` at `2.0.0`, whatever the repository is named

### Requirement: The build strategy prefers the standard paths

The tool guidance MUST direct the agent to try the standard path first. For R, that is a pak lockfile resolve of the local source tree, which pulls the CRAN and Bioconductor dependencies, with custom steps only when it fails. For Python, that is a wheel build of the tree, a hash-pinned resolve of the wheel's requirements against the index, and a dependency-free install of the wheel into the pool layout. The plan MUST state which strategy it proposes, and the guidance MUST live in the tool description the composition ships.

#### Scenario: A pure R package needs no custom step

- **GIVEN** SeedMatchR, a pure R package whose imports CRAN serves
- **WHEN** the session builds it through the standard path
- **THEN** pak resolves and installs it, and the build script holds the standard steps alone

### Requirement: The commit ask shows the script and the record, then one clean run

The tool MUST ask once before the commit, with the build script and the build record preview. An approval runs one clean run of the script in a new provisioner container over the pristine snapshot, and that run alone writes the store. A failure of the clean run MUST return to the same session, because the session build used a state that the script does not make; the agent corrects the script there and starts the clean run again. A rejection ends the session with no store change.

#### Scenario: An approved commit runs the script once

- **GIVEN** a session whose build succeeded and whose commit ask the user approves
- **WHEN** the clean run executes
- **THEN** one new container runs the build script, and the artifact lands in the pool from that run alone

#### Scenario: A failed clean run returns to the session

- **GIVEN** a clean run that fails
- **WHEN** the failure returns to the agent
- **THEN** the same session stays open, and no store directory was written

#### Scenario: A rejected commit changes nothing

- **GIVEN** a commit ask that the user rejects
- **WHEN** the ask throws
- **THEN** the session stops, and the pool holds no new store directory

### Requirement: A lost session costs no store state

The session is not durable. If the host process stops, the session is lost and its scratch volume is debris. The store MUST stay sound, because only the clean run writes it, and a clean run that stops mid-flight leaves staging that the repair step of the next provisioner run removes.

#### Scenario: A stopped host loses the session alone

- **GIVEN** a live session whose host process stops
- **WHEN** the next provisioner run starts
- **THEN** the repair step clears the abandoned staging, and `deps.json` and each farm are unchanged
