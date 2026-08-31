# package-store-transfers Delta

## MODIFIED Requirements

### Requirement: Three transfer kinds share one detached lifecycle

The transfer kinds MUST be: the runtime image, the provisioner image, and
the catalog. Each transfer MUST run as one detached child process — a
re-invocation of the CLI with a hidden flag, with ignored stdio and
`unref`. Each transfer MUST own one database row with its state, its byte
totals, and its failure message. The lock family MUST give the liveness: a
`running` row with no live lock holder reads as `failed`. One transfer per
kind runs at a time. The command palette MUST offer the re-download of the
images and of the catalog, through the same transfer children.

One exception exists: `store download --foreground` MUST run the catalog
transfer in the calling process, for a container whose primary process
must hold the pod open. The exit code MUST carry the outcome, and a
`failed` settle MUST print the recorded message. While a detached transfer
is live, a foreground run MUST refuse with exit code 1, because a silent
no-op in a Job reads as success.

#### Scenario: Three transfers run detached

- **WHEN** the setup starts the three transfers
- **THEN** three children run with their own rows, and the setup process exits without a wait

#### Scenario: A dead child reads as failed

- **GIVEN** a `running` row whose child process died
- **WHEN** the state is read
- **THEN** it reads as `failed`, with a retry command named

#### Scenario: A foreground run carries the outcome in its exit code

- **GIVEN** a catalog transfer that settles as `failed`
- **WHEN** `store download --foreground` runs it
- **THEN** the process exits 1, and the recorded message prints

#### Scenario: A live transfer refuses a foreground run

- **GIVEN** a live detached catalog transfer
- **WHEN** `store download --foreground` runs
- **THEN** the run refuses with exit code 1, and nothing transfers twice
