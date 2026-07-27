# container-runtime Specification (delta)

## MODIFIED Requirements

### Requirement: Setup falls back to any ready runtime

`inflexa setup` SHALL NOT require the selected runtime specifically. When a runtime is selected it SHALL be probed first, then the remaining supported runtimes in registry order (when none is selected, registry order alone applies); setup SHALL proceed with the first runtime that is installed and ready, and probing SHALL stop there. When the chosen runtime differs from the selection — or none was selected — setup SHALL inform the user and persist the choice to the `runtime` config key before any container work, so both the remainder of the setup run and later launches target the runtime that provisioned the stack; if persisting fails, setup SHALL abort rather than continue with a runtime later steps will not resolve. Only when no supported runtime is ready SHALL setup fail, and the error SHALL aggregate each runtime's specific guidance. Setup is the ONE entry point that may switch away from an explicit selection — everywhere else an explicit selection is a hard gate (see the pinning requirement).

An explicit runtime ANSWER (`--runtime docker|podman`; file `runtime`) SHALL instead be a hard gate within setup itself: the answered runtime is probed alone, is never switched away from, and a not-ready answered runtime fails setup with that runtime's specific guidance — an answer is provisioning intent, and silently falling back would let one fleet member provision a heterogeneous stack. On success the answer is persisted to the `runtime` config key exactly as a detected choice is. The fallback behavior above applies ONLY when no runtime answer is given.

#### Scenario: Selected runtime down, another runtime ready

- **WHEN** the `runtime` config is `docker`, the Docker daemon is not running, and Podman is installed and ready
- **THEN** setup proceeds with Podman, informs the user of the switch, and persists `runtime: podman`

#### Scenario: Selected runtime ready

- **WHEN** the selected runtime is installed and ready
- **THEN** setup uses it, the `runtime` config key is unchanged, and no other runtime is probed

#### Scenario: No selection at setup

- **WHEN** no runtime is selected and at least one supported runtime is ready
- **THEN** setup proceeds with the first ready runtime in registry order, informs the user, and persists it

#### Scenario: No runtime usable

- **WHEN** no supported runtime is installed and ready
- **THEN** setup fails with an error that aggregates each runtime's specific guidance, and performs no container work

#### Scenario: An answered runtime is a hard gate

- **WHEN** setup runs with `--runtime docker` while the Docker daemon is not running and Podman is ready
- **THEN** setup fails with Docker's specific guidance and does NOT fall back to Podman

#### Scenario: An answered runtime is persisted on success

- **WHEN** `setup --yes --runtime podman` runs and Podman is ready
- **THEN** setup proceeds with Podman and persists `runtime: podman`
