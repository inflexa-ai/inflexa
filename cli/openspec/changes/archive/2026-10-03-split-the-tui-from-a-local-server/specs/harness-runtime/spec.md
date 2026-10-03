# harness-runtime Delta

## RENAMED Requirements

- FROM: `### Requirement: On-demand composition of the embedded harness runtime`
- TO: `### Requirement: Composition of the embedded harness runtime`

## MODIFIED Requirements

### Requirement: Composition of the embedded harness runtime

The system SHALL provide a composition module that boots the embedded harness
runtime and reuses it for the remainder of the process. Two processes SHALL boot
it: the local server, at its start, after it binds its port; and the dev
`inflexa run --plan`, before its launch. No other process SHALL boot the runtime:
the TUI and each instance command reach the runtime of the local server through
its HTTP API.

The boot SHALL carry no analysis. One runtime serves each analysis of the
machine, thus each seam whose value depends on the analysis SHALL resolve it from
the session of each call, never from a value fixed at boot.

Boot SHALL sequence: ensure Postgres readiness; in callback mode only, start the
callback listener; take the machine-wide runtime lock; register the durable
workflows with fully realized deps — sandbox-step before execute-analysis, plus
data-profile and sandbox-hygiene scheduled workflows; run pre-launch
migration/hooks; then launch DBOS. No ephemeral execution workflow SHALL be
registered. Poll transport remains the default. A boot that finds the runtime
lock held by a different live process SHALL fail with an error that names the
holder pid, and SHALL launch nothing. A second boot request in the same process
SHALL return the singleton without re-registration or re-launch.

#### Scenario: First trigger boots the runtime in poll mode

- **WHEN** the start of the local server first requests the runtime
- **THEN** Postgres is ready, the non-ephemeral workflow cohort is registered, legacy pre-launch migration/hooks run, and DBOS launches in that order
- **AND** no callback listener is bound

#### Scenario: Callback mode additionally binds the listener

- **WHEN** runtime boots in callback transport mode
- **THEN** the exec-callback listener starts after Postgres readiness and before registration

#### Scenario: Subsequent triggers reuse the runtime

- **WHEN** a second boot is requested in the same process
- **THEN** no re-registration or re-launch occurs

#### Scenario: Unavailable Postgres blocks boot with actionable guidance

- **WHEN** runtime boot cannot reach ready Postgres
- **THEN** boot fails actionably and DBOS is not launched

#### Scenario: One registration cohort

- **WHEN** recovery resumes any supported in-flight workflow
- **THEN** its registered name exists in the one pre-launch cohort

#### Scenario: A second runtime on the machine is refused

- **GIVEN** the local server holds the runtime
- **WHEN** `inflexa run --plan` boots a runtime
- **THEN** the boot fails with an error that names the pid of the local server, and DBOS is not launched

### Requirement: The composition root realizes the tool-approval gateway

The embedded-runtime boot SHALL construct the harness ask gateway from the app
pool at the composition root, expose it on the runtime handle so surfaces can
answer and enumerate asks, and run the gateway's expiry sweep in the boot
chores that execute after the harness has initialized its state tables — so
pending asks orphaned by a prior process are expired before any new turn runs.

#### Scenario: The runtime handle carries the gateway

- **GIVEN** a booted harness runtime in the local server
- **WHEN** the ask routes of the local server list or answer an ask
- **THEN** the gateway is reachable from the runtime handle without constructing a second realization

#### Scenario: Orphaned asks are swept at boot

- **GIVEN** a prior process that died with a pending ask in the ledger
- **WHEN** the runtime boots
- **THEN** the sweep marks it expired before the first turn can run

### Requirement: The composition root binds the package-store seams

The composition root MUST bind the three package-store values of the
harness config. `libStorePath` names the store root. `farmSource` is
`{ kind: "per-analysis" }`, with a resolver that names `farms/<analysisId>`
and heals a missing farm as an empty one. `toolchainSource` is `"image"`,
because the published image owns conda and Node. The root MUST bind
`extendAnalysisFarm` to the composition linker, thus the `link_packages`
tool exists for every sandbox agent. The CLI wrapper of a link refusal MUST
append the remedy text that names `inflexa store add`, because the harness
error carries only the missing names.

The root MUST bind the farm inventory path, `farmLockFile`, as a function of
the analysis id: the `inflexa.lock` of `farms/<analysisId>`. The harness
resolves the path with the analysis id of the session of each read. One
runtime serves each analysis of the machine, thus a static path would give
each analysis the package inventory of one farm.

#### Scenario: The farm resolves per analysis

- **GIVEN** two analyses with two farms
- **WHEN** each starts a sandbox
- **THEN** each sandbox mounts its own farm at `/mnt/libs/farm`

#### Scenario: The package inventory follows the analysis of the session

- **GIVEN** one runtime and two analyses whose farms hold different packages
- **WHEN** a sandbox agent of each analysis lists the available packages
- **THEN** each answer reads the `inflexa.lock` of the farm of its own analysis

#### Scenario: The refusal carries the CLI remedy

- **GIVEN** a link request for a package that the pool does not hold
- **WHEN** the refusal reaches the user surface
- **THEN** the text names `inflexa store add <name>` as the retry
