## ADDED Requirements

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

### Requirement: `inflexa libs pull` resolves a bundle to a manifest and dedup-downloads its tracks

The CLI SHALL provide `inflexa libs pull [bundle]` that: detects the host
architecture via `uname -m` (mapping to `linux-amd64` / `linux-arm64`); resolves
the bundle to a per-bundle-per-arch **manifest** pinning each track's URL,
sha256, and size; computes a plan that SKIPS any track whose content digest is
already held; downloads the remaining tracks in parallel to `.part` files;
verifies each track's sha256 before use; and assembles the version. Re-running
`pull` when already current SHALL be a no-op that reports "up to date". The
command SHALL accept `--core` / `--full` to override the bundle and `--version`
to target a specific published version instead of `latest`.

#### Scenario: Arch is detected, never prompted

- **WHEN** `inflexa libs pull` runs
- **THEN** the target architecture is derived from `uname -m` and the user is not asked for it

#### Scenario: Unchanged tracks are not re-downloaded

- **GIVEN** a client already holding a track whose digest matches the manifest
- **WHEN** it pulls a bundle that pins that same digest
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

- **WHEN** `inflexa libs pull --version <V>` runs
- **THEN** the CLI resolves `<V>`'s manifest rather than `latest` and activates that version

### Requirement: packages.txt is assembled from exactly the pulled tracks

The CLI SHALL produce `/mnt/libs/current/packages.txt` by concatenating the
`packages.txt` fragments carried inside exactly the tracks that were pulled for
the selected bundle. The CLI SHALL NOT synthesize the package list from any
manifest wishlist. The assembled file SHALL be written into the staging version
before activation so it is never observed partially written.

#### Scenario: The mounted list matches the pulled tracks

- **WHEN** a bundle is pulled and activated
- **THEN** `/mnt/libs/current/packages.txt` equals the concatenation of the pulled tracks' fragments and nothing else

#### Scenario: A core bundle advertises no R packages

- **GIVEN** the `core` bundle (`python`, `conda`, `node`) is pulled
- **THEN** `packages.txt` contains no R packages, because no R track fragment was pulled

### Requirement: Bundle and architecture are resolved for the user, not asked

The CLI SHALL expose exactly two user-facing bundles — a **full** stack
(Python + R + conda) and a **core** stack (Python + conda) — and SHALL map the
user's choice plus the detected architecture onto the underlying track set. On
`linux-amd64` both bundles SHALL be resolvable; on `linux-arm64` only the core
bundle SHALL be resolvable, and a request for the full bundle SHALL be rejected
with an explanation that R libraries are not yet built for arm64 (not a bare
error), falling back to core. With no bundle argument on a machine with no store,
the CLI SHALL default to the full bundle on amd64 and the core bundle on arm64.

#### Scenario: arm64 offers only core

- **WHEN** bundle resolution runs on `linux-arm64`
- **THEN** only the core bundle is offered and full is reported as unavailable-on-arm64 with a reason

#### Scenario: Default bundle on a bare amd64 machine

- **GIVEN** `linux-amd64` with no store present
- **WHEN** `inflexa libs pull` runs with no bundle argument
- **THEN** the full bundle is selected

### Requirement: The setup flow provisions the store through the same pull handler

`inflexa setup` SHALL offer a single `@clack/prompts` choice between the full and
core stacks (core-only on arm64, with a `note()` explaining R's absence there),
then run the provisioning inside a `spinner()`. The setup flow SHALL invoke the
same pull handler that `inflexa libs pull` uses — it SHALL NOT implement a
separate download path. On a non-interactive terminal the setup flow SHALL use
the architecture-appropriate default bundle without prompting.

#### Scenario: Setup reuses the pull handler

- **WHEN** the user selects a stack during `inflexa setup`
- **THEN** provisioning calls the same handler as `inflexa libs pull`, wrapped in a spinner

#### Scenario: Non-interactive setup uses the default

- **WHEN** `inflexa setup` runs on a non-interactive terminal
- **THEN** the architecture-appropriate default bundle is provisioned without a prompt

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

### Requirement: `inflexa libs status` and `inflexa libs list` report store state

The CLI SHALL provide `inflexa libs status` reporting the store location, the
active bundle + version + architecture, the present tracks, the advertised
package count, and whether the active version is the latest resolvable one. The
CLI SHALL provide `inflexa libs list` reporting the bundles resolvable for the
detected architecture. When no store is present, `status` SHALL say so plainly
and point at `inflexa libs pull`.

#### Scenario: Status on a provisioned machine

- **GIVEN** an active store
- **WHEN** `inflexa libs status` runs
- **THEN** it prints the active bundle, version, architecture, present tracks, and up-to-date state

#### Scenario: Status with no store

- **GIVEN** no active store
- **WHEN** `inflexa libs status` runs
- **THEN** it reports that no store is installed and points the user at `inflexa libs pull`
