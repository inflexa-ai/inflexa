# package-store-download Specification

## ADDED Requirements

### Requirement: The catalog resolves as a digest-pinned OCI artifact

The downloader MUST resolve the catalog from GHCR by the `latest-<arch>`
tag of the host arch. It MUST pin the resolved digest for the whole
transfer. Verified blobs MUST land in a digest-keyed cache, thus a retry
does not fetch bytes that it holds. The receipt on disk MUST be written
last, and the receipt is the truth of what the store holds. A failed run
MUST drop the staged tree and keep the blob cache.

#### Scenario: A retry reuses the verified blobs

- **GIVEN** a failed transfer that verified two of three layers
- **WHEN** the download runs again
- **THEN** only the third layer transfers, and the receipt writes after the merge

#### Scenario: A disk-full failure names the numbers

- **GIVEN** a staging disk without room for the artifact
- **WHEN** the transfer fails
- **THEN** the failure names the bytes necessary and the bytes free

### Requirement: The merge is add-only and keeps user state

The merge into the store root MUST remove nothing. A `store/` name that both
sides hold is skipped, because the store is content-addressed. An existing
farm MUST be kept, because the download never replaces a farm of the user.
The graph moves in only when the root has none. Old versions stay until
`store reclaim` frees the unreferenced ones. `store add` MUST refuse while
a merge runs.

#### Scenario: A user farm survives the download

- **GIVEN** a store with the farm of a live analysis
- **WHEN** a catalog download merges
- **THEN** the farm is untouched, and the new store directories join the pool

### Requirement: A moved tag updates only with consent

A download over a valid receipt MUST resolve the manifest and transfer
nothing. A moved `latest-<arch>` tag MUST report `update_available`, and
`--update` is the consent that applies it. On `--update`, the new graph
MUST replace the old one whole, under the metadata lock, because two graphs
must not merge.

#### Scenario: A repeat download is a no-op

- **GIVEN** a valid receipt at the current tag
- **WHEN** `store download` runs
- **THEN** nothing transfers, and the state reports complete

#### Scenario: The update replaces the graph whole

- **GIVEN** a moved tag and the `--update` flag
- **WHEN** the merge completes
- **THEN** the new `deps.json` replaces the old one, and no node-level merge happens
