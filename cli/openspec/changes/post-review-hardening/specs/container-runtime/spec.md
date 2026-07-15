## MODIFIED Requirements

### Requirement: Configurable container runtime

The system SHALL expose an optional `runtime` configuration key whose value is one of a fixed set of supported container runtimes (`docker`, `podman`). An absent key SHALL mean no runtime has been chosen yet — resolved at first need per the pinning requirement, never silently treated as a `docker` choice. An unrecognized persisted value SHALL be treated as unset (re-detected at next need) so corrupt config never blocks startup — but it SHALL NOT be discarded silently: when the first-need pin resolves a runtime over a discarded value, the notice SHALL name the value that was ignored, so a typo'd selection is visible instead of masquerading as a fresh choice.

#### Scenario: Unset means no selection

- **WHEN** the config file has no `runtime` key
- **THEN** no runtime is selected, and the choice is resolved and pinned by the first command that needs containers

#### Scenario: Honors an explicit selection

- **WHEN** the config file sets `runtime` to `podman`
- **THEN** the active runtime is `podman`

#### Scenario: Unrecognized value is treated as unset

- **WHEN** the config file sets `runtime` to an unsupported value (e.g. `containerd`)
- **THEN** the value is treated as no selection and startup is not blocked

#### Scenario: Discarded value is named at pin time

- **WHEN** the config file holds an unrecognized `runtime` value and the first command that needs containers pins a detected runtime
- **THEN** the pin notice names the ignored value alongside the runtime being pinned

### Requirement: First need detects and pins the runtime

When no runtime is selected, a command that requires a container runtime SHALL probe the supported runtimes in registry order (`docker` first), proceed with the first one that is installed and ready, persist it to the `runtime` config key, and inform the user of the choice. Pinning (rather than re-detecting on every invocation) keeps later runs on the runtime that owns the provisioned state — a floating resolution would abandon a Podman-provisioned stack the moment Docker reappears and re-provision a colliding one. If persisting fails, the command SHALL abort rather than continue unpinned, because later steps resolve the runtime from config and an unpersisted detection could split one run across two runtimes. When no supported runtime is ready, the command SHALL fail with an error aggregating each runtime's specific guidance (missing-binary vs installed-but-not-ready, per runtime). An explicit selection SHALL remain a hard gate outside `inflexa setup`: it is probed alone and never silently switched — and because `inflexa setup` is the one sanctioned way out of a dead selection, the hard-gate failure SHALL name it as the path to switch runtimes. Read-only diagnostics (e.g. `inflexa sandbox status`) SHALL resolve a ready runtime for inspection without persisting anything.

#### Scenario: No selection, Docker stopped, Podman ready

- **WHEN** no runtime is selected, the Docker daemon is not running, and Podman is installed and ready
- **THEN** the command proceeds with Podman, informs the user, and persists `runtime: podman`

#### Scenario: No selection, both runtimes ready

- **WHEN** no runtime is selected and both Docker and Podman are ready
- **THEN** the command proceeds with Docker (registry order) and persists `runtime: docker`

#### Scenario: Explicit selection stays a hard gate

- **WHEN** the config selects `docker`, the Docker daemon is not running, and Podman is ready
- **THEN** a non-setup command fails with Docker's remediation guidance, the config is unchanged, and the error names `inflexa setup` as the way to switch runtimes

#### Scenario: Read-only status does not pin

- **WHEN** `inflexa sandbox status` runs with no runtime selected
- **THEN** presence is reported against a detected ready runtime (or as unknown when none is), and the `runtime` config key is not written
