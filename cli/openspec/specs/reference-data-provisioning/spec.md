# reference-data-provisioning Specification

## Purpose

Define the CLI's public reference-store location, catalog-driven installation,
verification, setup integration, and ownership boundary for user-provided data.

## Requirements

### Requirement: The CLI exposes a stable public reference-store directory

The CLI SHALL resolve a `refsDir` under the platform data home at `<data-home>/inflexa/refs`. Root help SHALL list the directory in its Paths table, and `inflexa refs path` SHALL print the exact resolved path without creating it. Deliberate setup or reference-download actions SHALL create the directory and a documented `user/` namespace for arbitrary user-provided reference data.

#### Scenario: User discovers the host path

- **WHEN** the user runs root help or `inflexa refs path`
- **THEN** the CLI displays the host directory whose contents sandboxes see at `/mnt/refs`

#### Scenario: Path inspection does not litter

- **WHEN** `inflexa refs path` runs before the store exists
- **THEN** it prints the path and creates no directory or metadata

### Requirement: Managed and user-owned namespaces have separate ownership

The CLI installer SHALL write catalog-managed datasets only beneath `managed/<dataset-id>/<version>` and its own metadata only beneath `.inflexa/`. It SHALL recommend `user/` for arbitrary additions and SHALL NOT overwrite, adopt, verify as managed, prune, or delete content under `user/` or unknown top-level paths.

#### Scenario: User-added reference survives managed update

- **WHEN** a user places files under `refs/user/custom-atlas/` and updates a catalog dataset
- **THEN** the installer changes only its managed dataset/version and receipt paths and leaves the custom atlas byte-for-byte untouched

### Requirement: Reference options come from the harness catalog

The CLI SHALL consume the harness-exported reference catalog and install-plan interface rather than defining a second list. `inflexa refs list` SHALL show each catalog dataset's id, version, description, size, integrity class, source and licensing links, recommendation/group metadata, and local state. The CLI SHALL fetch every artifact from the upstream URL the catalog names and SHALL NOT provide any means — environment variable, flag, or config — of redirecting a fetch to a different origin.

Because an `unpinned` artifact's size is known only to its mutable upstream, a displayed size SHALL distinguish bytes the catalog knows from files whose size the upstream determines, and SHALL NOT invent a total.

#### Scenario: Catalog option is visible with links

- **WHEN** `inflexa refs list` runs
- **THEN** every downloadable option from the installed harness version is shown with its upstream source/licensing links, its integrity class, and its local installation state

#### Scenario: The download source cannot be redirected

- **WHEN** a user or operator wishes to install catalog data from somewhere other than its publisher
- **THEN** the CLI offers no such configuration, and the only supported way to add other reference data is to place files under the store's `user/` namespace

#### Scenario: Unknown id is rejected before download

- **WHEN** `inflexa refs download unknown-id` runs
- **THEN** the CLI reports the unknown id and available ids and performs no network or filesystem mutation

### Requirement: Downloads are verified and dataset activation is atomic

For each selected dataset, the CLI SHALL download artifacts to installer-owned `.part` paths, verify every `pinned` artifact against the catalog's byte size and SHA-256 digest, stage every final file beneath one attempt directory, and activate the complete version directory only after all artifacts are accounted for. It SHALL then atomically write a harness-compatible active receipt recording the size and digest **observed** for each artifact. A failed or interrupted attempt SHALL leave any previously active receipt/version unchanged and SHALL never expose a partially staged dataset as active managed content, and SHALL NOT leave orphaned staging directories behind.

Resuming a partial transfer SHALL be attempted only for a `pinned` artifact. An `unpinned` artifact SHALL be re-fetched whole, because its upstream may have replaced the file since the partial was written and appending to it would splice two different files into one that verifies against nothing.

#### Scenario: Complete dataset activates

- **WHEN** every artifact downloads, and every `pinned` artifact matches its catalog size and digest
- **THEN** the complete version appears under `managed/<id>/<version>` and its receipt records the observed size, digest, and integrity class of each file

#### Scenario: Digest mismatch preserves prior version

- **WHEN** any `pinned` artifact fails size or SHA-256 verification
- **THEN** the command fails, the staged version is not activated, and the prior active receipt and version remain unchanged

#### Scenario: Interrupted pinned download is resumable but not visible

- **WHEN** a transfer stops after writing part of a `pinned` artifact
- **THEN** resumable installer-owned partial state may remain and is resumed by range request, but no partial dataset appears as active managed reference data

#### Scenario: A mutable upstream is never resumed into

- **WHEN** a partial `.part` exists for an `unpinned` artifact
- **THEN** the CLI discards it and fetches the whole file again rather than appending to bytes the upstream may have since replaced

### Requirement: Reference commands expose install, verification, and path operations

The CLI SHALL provide `inflexa refs list`, `inflexa refs download [ids...]`, `inflexa refs verify [ids...]`, and `inflexa refs path`. Interactive download with no ids SHALL offer a multi-select. Before transfer, download SHALL show the missing size and require confirmation unless explicit non-interactive consent is present. Verify SHALL hash active managed files against their receipt and SHALL report missing, modified, and valid states without modifying them, naming for each file which guarantee was checked — the catalog's checksum for a `pinned` file, the checksum recorded at install for an `unpinned` one.

`inflexa refs download --force` SHALL re-fetch and re-activate a dataset even when its active install is intact. This is the supported way to refresh an `unpinned` dataset, whose upstream may have moved on in a way no local inspection can detect.

#### Scenario: Interactive selection shows cost before consent

- **WHEN** an interactive user selects multiple missing datasets
- **THEN** the CLI shows the combined missing download size and begins transfer only after confirmation

#### Scenario: Verification detects manual damage

- **WHEN** an active managed file has been edited or removed
- **THEN** `inflexa refs verify` reports the affected dataset and file as invalid, names the repair command, exits non-zero, and changes no bytes

#### Scenario: A mutable upstream is refreshed on request

- **WHEN** an `unpinned` dataset is installed and intact, and the user runs `refs download <id> --force`
- **THEN** the CLI re-fetches from the upstream and re-activates, replacing the receipt with the newly observed digests

### Requirement: Setup reuses the reference download handler

Interactive `inflexa setup` SHALL deliberately create the reference-store and `user/` directories, inspect catalog installation state, and offer missing or updateable datasets with their sizes through the same headless download operation used by `inflexa refs download`. Declining or selecting nothing SHALL continue setup. A selected installation failure SHALL fail setup visibly.

Headless setup SHALL download no reference bytes unless dataset ids and non-interactive consent are explicit. Without them it SHALL print the reference-store path and an actionable `inflexa refs download` command and continue.

#### Scenario: Setup and explicit command share one installer

- **WHEN** setup installs a selected dataset
- **THEN** it produces the same managed layout, verification, activation, and receipt as `inflexa refs download` for that id

#### Scenario: Headless setup does not silently download

- **WHEN** setup runs without a TTY and without explicit reference ids and consent
- **THEN** it downloads nothing, prints how to install references later, and continues

#### Scenario: User declines optional references

- **WHEN** an interactive user declines or selects no catalog datasets
- **THEN** setup leaves the public store available for manual additions and continues successfully

### Requirement: Missing or inconsistent managed state is recoverable

Cheap status inspection SHALL derive managed state from the catalog, receipts, and filesystem and SHALL report at least missing, installed, update available, partial, and invalid-receipt states. Absence or inconsistency SHALL NOT crash the CLI. Re-running download for a selected dataset SHALL repair installer-owned content through normal staged verification and activation.

Deciding whether an install may be skipped as already-complete SHALL compare digests, not sizes. A size-only check cannot see a same-size corruption — a flipped byte, a bad sector, a hand-edit — and would skip the repair while reporting the dataset as installed, which is a false claim of success. Cheap listing MAY remain size-only, but an install SHALL NOT be skipped on that basis.

#### Scenario: Receipt references a deleted file

- **WHEN** a receipt names a managed file that is absent
- **THEN** list reports a partial or damaged state and download can repair it without database surgery or changes to user content

#### Scenario: Same-size corruption is repaired, not skipped

- **WHEN** an installed artifact is corrupted in place without changing its byte length, and download is re-run for that dataset
- **THEN** the CLI detects the digest mismatch, re-downloads and re-activates the dataset, and never reports it as already installed with nothing transferred
