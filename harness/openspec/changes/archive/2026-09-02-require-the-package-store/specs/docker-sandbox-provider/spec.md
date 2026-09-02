## MODIFIED Requirements

### Requirement: Farm resolution comes before the container

When `libStorePath` is configured, `createSandbox` MUST resolve the farm
source before any container work. A resolver throw and an `unavailable`
result MUST refuse the call with the `farm_unavailable` `SandboxError`
variant. The reason of the embedder MUST ride in the error. When the
resolved farm fails the `inflexa.lock` gate and the config declares
`packageStore: "required"`, the backend MUST refuse the call with the
`farm_unusable` variant before any container work, and the variant MUST
carry the farm path, the lock path, the lock error type, and the cause.
Without the fact, the backend MUST drop both store mounts, log a warning,
and still make the container. The sandbox then reports the store as
unavailable.

#### Scenario: A resolver refusal carries the embedder reason

- **GIVEN** a `per-analysis` farm source whose resolver returns `unavailable` with "the store download is in progress"
- **WHEN** `createSandbox` runs
- **THEN** the call returns a `farm_unavailable` error that carries that reason, and no container is made

#### Scenario: An unusable farm degrades the sandbox

- **GIVEN** a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the backend makes the container with no `/mnt/libs` mount and no farm mount, and a warning is logged

#### Scenario: An unusable farm refuses under the required store

- **GIVEN** `packageStore: "required"` and a resolved farm whose `inflexa.lock` does not parse
- **WHEN** `createSandbox` runs
- **THEN** the call returns a `farm_unusable` error with the lock path and `lock_invalid`, no container is made, and no warning is logged

## ADDED Requirements

### Requirement: The client seam throws the described failure

`createSandboxClient` MUST convert the `SandboxError` of each sandbox op
(`createSandbox`, `teardown`, `teardownById`, `isAlive`, `isAliveById`,
`listManagedSandboxes`) into a thrown `SandboxFailure`. The message MUST be
the description of the variant, and the variant MUST ride as the cause.
The description of a variant that carries a cause MUST end with the first
line of the cause message, bounded to 200 characters. A zod cause MUST
render as its first issue, the path and the message, because its message
is multi-line JSON. A cause without a message adds nothing. The
`farm_unavailable` variant takes no cause line, because its head already
carries the reason of the resolver. The registry writes of the seam keep
the plain bridge, because they carry a database error.

#### Scenario: A create refusal reaches the caller with its description

- **GIVEN** a backend op that returns `farm_unusable` for the lock path `/mnt/libs/farms/catalog/inflexa.lock`
- **WHEN** the client `createSandbox` runs
- **THEN** it throws a `SandboxFailure` whose message names `farm unusable`, the lock path, and the lock error type, and whose cause is the variant

#### Scenario: An engine failure carries its reason

- **GIVEN** a backend op that returns `container_create_failed` with a cause whose message starts with `no such image: sandbox-base:latest`
- **WHEN** the client `createSandbox` runs
- **THEN** the thrown message ends with `no such image: sandbox-base:latest`

#### Scenario: A long cause is bounded

- **GIVEN** a cause whose first line has 500 characters
- **WHEN** the description is built
- **THEN** the appended line has 200 characters at most

#### Scenario: A zod cause names its first issue

- **GIVEN** a `farm_unusable` error whose cause is a `ZodError` with its first issue at the path `schema`
- **WHEN** the description is built
- **THEN** it ends with `schema: ` and the message of that issue, and no `[` appears
