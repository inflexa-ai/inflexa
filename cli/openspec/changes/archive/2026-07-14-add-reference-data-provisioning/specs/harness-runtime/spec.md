## ADDED Requirements

### Requirement: Existing local reference store is mounted read-only into sandboxes

The CLI harness composition SHALL supply `refStorePath` to the harness sandbox client exactly when `env.refsDir` already exists. It SHALL NOT create the directory during runtime boot or passive launch. An existing directory, including an empty one, SHALL be mounted read-only by the harness at `/mnt/refs`; an absent directory SHALL leave the mount unconfigured so Docker cannot auto-create a root-owned bind source.

#### Scenario: Deliberately created store is wired

- **GIVEN** setup, reference download, or the user has created `env.refsDir`
- **WHEN** the embedded harness runtime creates a Docker sandbox
- **THEN** the sandbox client receives that host path as `refStorePath` and the sandbox sees it read-only at `/mnt/refs`

#### Scenario: Missing store is not auto-created

- **GIVEN** `env.refsDir` does not exist
- **WHEN** the runtime boots and creates a sandbox
- **THEN** `refStorePath` is omitted and neither the CLI nor Docker creates the host directory as a side effect of composition

#### Scenario: Empty store remains distinguishable from no mount

- **GIVEN** `env.refsDir` deliberately exists but contains no reference data
- **WHEN** a sandbox is created
- **THEN** it receives the empty read-only mount so harness discovery can report mounted-but-empty rather than unmounted
