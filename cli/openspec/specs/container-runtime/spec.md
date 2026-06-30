# container-runtime Specification

## Purpose
Let users choose the container backing system (Docker or Podman) that runs the CLIProxyAPI proxy, via a `runtime` config key defaulting to Docker. A single execution wrapper resolves the configured binary, surfaces runtime-aware readiness errors, and owns per-runtime command divergence (e.g. Podman's `:z` bind-mount relabel) so callers never hard-code a container binary.

## Requirements
### Requirement: Configurable container runtime

The system SHALL expose a `runtime` configuration key whose value is one of a fixed set of supported container runtimes (`docker`, `podman`). The system SHALL default the runtime to `docker` when the key is absent, and SHALL fall back to `docker` when the persisted value is not a recognized runtime, so that existing installs and corrupt config never block startup.

#### Scenario: Default when unset

- **WHEN** the config file has no `runtime` key
- **THEN** the active runtime is `docker`

#### Scenario: Honors an explicit selection

- **WHEN** the config file sets `runtime` to `podman`
- **THEN** the active runtime is `podman`

#### Scenario: Unrecognized value falls back

- **WHEN** the config file sets `runtime` to an unsupported value (e.g. `containerd`)
- **THEN** the active runtime is `docker` and startup is not blocked

### Requirement: Single execution wrapper for container commands

The system SHALL route every container invocation through a single execution wrapper rather than spawning a hard-coded binary. The wrapper SHALL resolve the binary from the active runtime, and the shared spawn mechanics (output-capturing and stdio-inheriting variants) SHALL be identical across runtimes. No module outside the wrapper SHALL reference a container binary name directly.

#### Scenario: Commands use the configured binary

- **WHEN** the active runtime is `podman` and a container command is issued
- **THEN** the wrapper spawns the `podman` binary with the given arguments

#### Scenario: Capture and inherit variants exist

- **WHEN** a caller needs the command's captured stdout/stderr/exit code, or needs to inherit the terminal for interactive/progress output
- **THEN** the wrapper provides both variants and both target the active runtime's binary

### Requirement: Runtime-aware readiness check

The system SHALL verify the active runtime is installed and usable before issuing container commands, and SHALL produce error guidance specific to that runtime. A missing binary and an installed-but-not-ready runtime SHALL produce distinct, actionable messages naming the active runtime.

#### Scenario: Binary not installed

- **WHEN** the active runtime's binary is not found on `PATH`
- **THEN** the system reports an actionable error naming that runtime and its install guidance, and does not proceed

#### Scenario: Installed but not ready

- **WHEN** the active runtime's binary exists but the runtime is not ready (e.g. Docker daemon down, or Podman machine not started)
- **THEN** the system reports an actionable error with runtime-specific remediation, and does not proceed

### Requirement: Per-runtime command divergence

The system SHALL allow each runtime to diverge from the common command form where the runtimes are not interchangeable, expressed through the runtime descriptor rather than scattered conditionals at call sites. Bind-mount arguments SHALL be built per runtime: Podman SHALL append the `:z` shared SELinux relabel suffix; Docker SHALL use the bare `host:container` form.

#### Scenario: Podman bind mounts are relabeled

- **WHEN** the active runtime is `podman` and a bind mount is built
- **THEN** the mount argument is `host:container:z`

#### Scenario: Docker bind mounts are unmodified

- **WHEN** the active runtime is `docker` and a bind mount is built
- **THEN** the mount argument is `host:container`

### Requirement: Runtime selection in settings

The settings TUI SHALL present the container runtime as a selectable option (a radio-style group with one entry per supported runtime), persist the selection to config, and visually mark the active runtime.

#### Scenario: Selecting a runtime persists it

- **WHEN** the user selects `podman` in settings and saves
- **THEN** the `runtime` key is written to config as `podman` and is the active runtime on the next run

#### Scenario: Active runtime is marked

- **WHEN** the settings screen is shown
- **THEN** the currently active runtime is visually indicated among the options

