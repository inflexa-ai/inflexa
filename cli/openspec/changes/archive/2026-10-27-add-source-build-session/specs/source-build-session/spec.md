# Spec Delta

## Purpose

The CLI realization of the harness build session: how the embedder holds the provisioner container, channels commands, walls the egress, snapshots the source, and flies the clean run into the package store.

## ADDED Requirements

### Requirement: The CLI binds the build session

The CLI composition MUST bind the harness `BuildSession` interface with a realization of its own, in the conversation composition deps. The harness adds the `install_from_source` tool to the conversation roster when the interface is bound; the CLI MUST NOT also pass the tool through the host-tool seam, because one tool of one name must not register twice. The binding MUST be absent when no container runtime is configurable, in which case the tool stays off the roster.

#### Scenario: The tool is on the conversation roster once

- **GIVEN** a CLI session with a working container runtime
- **WHEN** the conversation agent is composed
- **THEN** the roster holds exactly one `install_from_source` tool, added by the harness through the bound interface

### Requirement: A session is a held container with the wall installed at start

The session realization MUST start the provisioner image as a held container whose entrypoint override applies the egress allowlist of the session — the same allowlist function the provisioner entrypoint uses — and then holds. A move to the build phase, or an amended plan, MUST restart the container under the new approved list over the same scratch volume, so the wall always matches the approved hosts. The container MUST receive no store mount at `/mnt/libs`, one scratch volume for the pristine snapshot and the working copy, with the pristine snapshot mounted read-only inside the session, and, for a folder source, no bind of the original folder (the host copies the folder in). The host MUST remove the container when the session ends, and a container whose host process died MUST be removable as debris.

#### Scenario: The session container holds no store bind

- **WHEN** the session container starts
- **THEN** its mounts hold the scratch volume alone, and no `/mnt/libs` mount

#### Scenario: The pristine snapshot is read-only in the session

- **GIVEN** a session whose build commands write into its working copy
- **WHEN** a command of any user writes into the pristine snapshot path
- **THEN** the write fails, and the clean run still reads the untouched snapshot

#### Scenario: The exploration wall holds the git host alone

- **GIVEN** a start of a GitHub source
- **WHEN** the exploration container starts
- **THEN** its egress variable holds the git host of the source and no other host

#### Scenario: An approval restarts the container under the approved list

- **GIVEN** an approved plan whose host list names the snapshot host, the index, and the pak repositories
- **WHEN** the session moves to the build phase
- **THEN** the new container carries the approved list, and the pristine snapshot is the same tree

### Requirement: Each command runs as one exec with a timeout and a user rule

Each command MUST arrive through the container runtime's exec channel with its own timeout, and each exec MUST start a fresh shell. An exec MUST run as the non-root user of the image by default, and the tool MAY mark one exec as root — the ask of a root exec MUST say so. A command that outlives its timeout MUST be killed and reported as timed out.

#### Scenario: Each command runs in a fresh shell with a timeout

- **GIVEN** a session and two commands
- **WHEN** the realization executes them
- **THEN** each runs through its own exec with its own timeout, and one command outliving its timeout is killed and reported as timed out

#### Scenario: A build command runs as the non-root user

- **GIVEN** a build command that the tool does not mark as root
- **WHEN** the realization executes it
- **THEN** it runs as the non-root user of the image

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

For a git source, the host MUST clone the repository at the resolved commit into the pristine snapshot under the scratch volume, before the first session command, and the session MUST NOT clone again. For a local folder, the host MUST copy the folder into the pristine snapshot and hash that copy with the tree hash of the provisioner, before the first session command. The session works on a working copy, and the clean run reads the pristine snapshot alone. A private repository authenticates with the token the host environment holds under `GITHUB_PAT`, passed into the environment of the clone command alone, and the token MUST NOT appear in any later exec environment, the plan, the build record, or any flight row.

#### Scenario: The clone lands at the resolved commit

- **GIVEN** the source `https://github.com/tacazares/SeedMatchR` resolved to commit `2fc0c4f`
- **WHEN** the session starts
- **THEN** the pristine snapshot holds the tree at `2fc0c4f`, and the session needs no clone step

#### Scenario: The folder hash precedes the session and covers the copy

- **GIVEN** a local folder source
- **WHEN** the session starts
- **THEN** the recorded tree hash is the hash of the pristine copy, computed before any command, and the original folder is never mounted

#### Scenario: The token rides the clone alone

- **GIVEN** a private git source and a host that holds `GITHUB_PAT`
- **WHEN** the clone runs
- **THEN** the clone command's environment holds the token, and no later exec environment holds it

### Requirement: The clean run flies through the store flight tail

The commit of a session MUST launch one `acquire-source` provisioner run that takes the pristine snapshot and the approved build script, with the session egress class and the image digests in its environment. The run writes the artifact into the pool and stages the graph nodes as one report, and the flight MUST then run the unchanged tail: the load check inside the sandbox image, with the link rule over the staged source-built directories, the graph commit under the metadata lock, and the farm extension of the analysis the conversation serves — the tool carries the analysis id of its session scope into `start`, and the commit extends that analysis, a binding that answers no analysis is a binding fault, not a mode. The source flight row MUST be created at the clean run, keyed by the qualified pin, and the row MUST be claimed before the run launches, so a reclamation sees the live work. A failed check or commit MUST leave no advertised state and MUST settle as a terminal `failed` flight row whose phase names where it stopped, exactly as an index acquisition does. A farm-extension failure MUST NOT fail the flight, exactly as an index acquisition: the packages are in the pool and the graph, and a later link extends the farm. The retry route of the flight surfaces MUST refuse a source row, because a source build restarts through the tool and not through an index `store add`.

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
