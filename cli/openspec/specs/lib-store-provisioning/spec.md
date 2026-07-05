# lib-store-provisioning Specification

## Purpose
TBD - created by archiving change add-lib-store-pull. Update Purpose after archive.
## Requirements
### Requirement: The CLI provisions the library store as a versioned, atomically-activated directory

The CLI SHALL obtain the library store into a host directory under the data dir
(`join(dataDir(),"inflexa","libs")`, the `libStorePath`), laid out as one
subdirectory per **version** with a single `current` symlink naming the active
version. A pull SHALL extract into a staging directory, verify it, and only then
rename it to its version directory and flip `current` onto it. The `current`
pointer SHALL always name a complete, verified store or be absent — it SHALL
NEVER name a partial one. Activated version directories SHALL be treated as
immutable.

#### Scenario: A completed pull activates via an atomic pointer swap

- **WHEN** a pull finishes downloading, verifying, extracting, and assembling a version
- **THEN** the CLI renames the staging directory to `<version>/` and updates `current` to point at it in a single atomic operation

#### Scenario: A sandbox launched mid-pull never sees a partial store

- **GIVEN** a pull is in progress writing a new version
- **WHEN** a sandbox launches and resolves `/mnt/libs/current`
- **THEN** it sees the previously-active version, or the new version, but never a half-written tree

#### Scenario: An interrupted pull leaves the active store unchanged

- **GIVEN** an existing active version and a pull that fails or is cancelled before activation
- **WHEN** the process exits
- **THEN** `current` still points at the previously-active version and the staging directory is discarded on the next pull

#### Scenario: A concurrent pull is refused, not run in parallel

- **GIVEN** a pull is already provisioning the store (holding the machine-wide pull lock)
- **WHEN** a second `inflexa libs pull` runs
- **THEN** the second pull mutates nothing; it reports that a pull is already in progress (with the holder's pid) and leaves `current` untouched

### Requirement: `inflexa libs pull` resolves the arch's manifest and dedup-downloads its tracks

The CLI SHALL provide `inflexa libs pull` that: detects the host architecture
via `uname -m` (mapping to `linux-amd64` / `linux-arm64`); fetches that arch's
**manifest** pinning each track's store-relative `path` (plus an absolute `url`
for compatibility), sha256, and size; pulls exactly the tracks the manifest
pins (an unknown track name fails loud — the store is newer than the CLI);
computes a plan that SKIPS any track whose content digest is already held;
downloads the remaining tracks in parallel to `.part` files — resolving each
track's download URL from the manifest `path` joined onto the configured base so
an `INFLEXA_LIB_STORE_URL`/`libStoreUrl` mirror redirects the payloads too, not
only the manifest; verifies each track's sha256 before use; and assembles the
version. Re-running `pull` when already current SHALL be a no-op that reports "up
to date". The command SHALL accept `--pin <version>` to target a specific
published version instead of `latest`.

#### Scenario: Arch is detected, never prompted

- **WHEN** `inflexa libs pull` runs
- **THEN** the target architecture is derived from `uname -m` and the user is not asked for it

#### Scenario: Unchanged tracks are not re-downloaded

- **GIVEN** a client already holding a track whose digest matches the manifest
- **WHEN** it pulls a version that pins that same digest
- **THEN** that track is not downloaded again and only differing tracks transfer

#### Scenario: A corrupt or mismatched track fails loud

- **GIVEN** a downloaded track whose sha256 does not match the manifest
- **WHEN** verification runs
- **THEN** the pull fails with a clear error, the track is discarded, and `current` is left unchanged

#### Scenario: Re-pull when current is a no-op

- **GIVEN** the active version already equals the resolved manifest's version
- **WHEN** `inflexa libs pull` runs
- **THEN** nothing is downloaded and the command reports the store is up to date

#### Scenario: A specific version can be targeted

- **WHEN** `inflexa libs pull --pin <V>` runs
- **THEN** the CLI resolves `<V>`'s manifest rather than `latest` and activates that version

### Requirement: packages.txt is assembled from exactly the pulled tracks

The CLI SHALL produce `/mnt/libs/current/packages.txt` by concatenating the
`packages.txt` fragments carried inside exactly the tracks that were pulled,
beneath a fixed advisory header (identical to the one the local/offline
assembler emits, so both producers write the same file). The CLI SHALL NOT
synthesize the package list from any manifest wishlist. The assembled file
SHALL be written into the staging version before activation so it is never
observed partially written.

#### Scenario: The mounted list matches the pulled tracks

- **WHEN** a store is pulled and activated
- **THEN** `/mnt/libs/current/packages.txt` equals the fixed advisory header followed by the concatenation of the pulled tracks' fragments and nothing else

#### Scenario: An arm64 store advertises no R packages

- **GIVEN** an arm64 pull (the arm64 manifest pins no R tracks)
- **THEN** `packages.txt` contains no R packages, because no R track fragment was pulled

### Requirement: Architecture decides the store contents, the user is never asked

The published store SHALL be per-architecture: the detected arch's manifest
pins exactly the tracks that machine gets (all six on `linux-amd64`; the non-R
tracks on `linux-arm64`, because R libraries are not yet built for arm64). The
CLI SHALL NOT expose a bundle or stack choice. On arm64 the pull SHALL surface
the R-unavailability rationale as an informational note, not an error.

#### Scenario: arm64 pull explains R's absence

- **WHEN** `inflexa libs pull` runs on `linux-arm64`
- **THEN** the pull proceeds with the manifest's non-R tracks and prints a note explaining that R libraries are not yet built for arm64

### Requirement: The setup flow provisions the store through the same pull handler

`inflexa setup` SHALL hand off to the same pull handler that `inflexa libs pull`
uses — it SHALL NOT implement a separate download path — which confirms the
planned download size before transferring and runs the provisioning inside a
`spinner()`. Declining the download SHALL skip the store and continue setup,
never abort it. On a non-interactive terminal the setup flow SHALL NOT
auto-download the store; it SHALL print a hint to run `inflexa libs pull --yes`
and continue setup successfully.

#### Scenario: Setup reuses the pull handler

- **WHEN** setup reaches the library-store step interactively
- **THEN** provisioning calls the same handler as `inflexa libs pull`, which confirms the download size and runs inside a spinner

#### Scenario: Declining the download skips the store

- **WHEN** the user declines the download-size confirmation during `inflexa setup`
- **THEN** the library store is skipped and setup continues to completion rather than aborting

#### Scenario: Non-interactive setup does not auto-download

- **WHEN** `inflexa setup` runs on a non-interactive terminal
- **THEN** the library store is not downloaded; the CLI prints a hint to run `inflexa libs pull --yes` and setup continues

### Requirement: A missing store is offered, never fatal

Before launching a sandbox, when no active store is present, the CLI SHALL
surface a one-line, actionable offer to run `inflexa libs pull` (including the
approximate download size), and SHALL allow continuing without the store. A
missing store SHALL NOT block the launch, because the harness degrades
gracefully (`list_available_packages` returns `available:false`).

#### Scenario: Missing store surfaces an offer and continues

- **GIVEN** no active store on disk
- **WHEN** a sandbox is about to launch
- **THEN** the CLI prints an offer to run `inflexa libs pull` and the launch proceeds without the store rather than aborting

### Requirement: The harness store mount is configured only when the store exists

The CLI SHALL expose a `libStorePath` configuration knob defaulting to
`join(dataDir(),"inflexa","libs")`, and the harness-runtime composition SHALL set
`libStorePath` on the sandbox configuration **only when the `current` pointer
actually exists on disk**. When no active store is present, the CLI SHALL leave
`libStorePath` unset so no bind mount is created. This prevents the container
runtime from auto-creating a missing bind source as a root-owned empty directory.

#### Scenario: No mount without a store

- **GIVEN** no `current` pointer exists under `libStorePath`
- **WHEN** the harness sandbox configuration is built
- **THEN** `libStorePath` is left unset and no `/mnt/libs` bind mount is created

#### Scenario: Mount appears once the store is provisioned

- **GIVEN** a completed `inflexa libs pull` has created `current`
- **WHEN** the next sandbox configuration is built
- **THEN** `libStorePath` is set and the store is bind-mounted read-only at `/mnt/libs`

### Requirement: Sandboxes are forced onto the pulled store's architecture

Each pulled version SHALL record its architecture in the version's `meta.json`.
When a store is mounted, the harness-runtime composition SHALL derive the
Docker platform (`linux/amd64` / `linux/arm64`) from the ACTIVE version's
recorded arch and force sandbox containers onto it — the store's native
binaries must never run in a mismatched-arch container. When no store is
mounted, or the active version's arch is unreadable/unknown (e.g. a local
build without metadata), no platform SHALL be forced.

#### Scenario: The sandbox platform follows the store's recorded arch

- **GIVEN** an active store whose `meta.json` records `linux-amd64`
- **WHEN** the harness sandbox configuration is built
- **THEN** sandbox containers are created with the `linux/amd64` platform

#### Scenario: No store, no forced platform

- **GIVEN** no mounted store (or an active version with no readable arch)
- **WHEN** the harness sandbox configuration is built
- **THEN** no container platform is forced and Docker's default applies

### Requirement: `inflexa libs status` reports store state

The CLI SHALL provide `inflexa libs status` reporting the store location, the
active version + architecture, the present tracks, the advertised package
count, and whether the active version is the latest resolvable one. When no
store is present, `status` SHALL say so plainly and point at
`inflexa libs pull`.

#### Scenario: Status on a provisioned machine

- **GIVEN** an active store
- **WHEN** `inflexa libs status` runs
- **THEN** it prints the active version, architecture, present tracks, and up-to-date state

#### Scenario: Status with no store

- **GIVEN** no active store
- **WHEN** `inflexa libs status` runs
- **THEN** it reports that no store is installed and points the user at `inflexa libs pull`

