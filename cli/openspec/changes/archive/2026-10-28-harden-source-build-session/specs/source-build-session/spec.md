## MODIFIED Requirements

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
