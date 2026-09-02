# package-store-download Specification

## Purpose

The catalog download of the package store. The transfer is a digest-pinned OCI pull from GHCR, with a blob cache, an add-only merge into the store root, and a receipt written last.

## Requirements

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

The merge into the store root MUST remove nothing of the user. A `store/`
name that both sides hold is skipped, because the store is content-addressed.
An existing farm of an analysis MUST be kept, but the catalog farm belongs
to the publisher — the update requirement below governs it. The graph and
the image record `image-packages.json` move in only when the root has
none. Old versions stay until `store reclaim` frees the unreferenced ones.
`store add` MUST refuse while a merge runs.

#### Scenario: A user farm survives the download

- **GIVEN** a store with the farm of a live analysis
- **WHEN** a catalog download merges
- **THEN** the farm is untouched, and the new store directories join the pool

#### Scenario: The image record lands on the first download

- **GIVEN** a store root with no `image-packages.json`
- **WHEN** a catalog download merges
- **THEN** the staged `image-packages.json` moves into the store root

### Requirement: A moved tag updates only with consent

A download over a valid receipt MUST resolve the manifest and transfer
nothing. A moved `latest-<arch>` tag MUST report `update_available`, and
`--update` is the consent that applies it. On `--update`, the new graph
MUST replace the old one whole, under the metadata lock, because two graphs
must not merge.

On `--update`, the staged catalog farm MUST replace `farms/catalog` in the
same run, and each other farm stays untouched. The old catalog closure
names the store directories of the old graph. Thus a kept catalog farm
beside a new graph refuses every farm-less compose with `unknown_root`, and
it serves stale template subtrees.

On `--update`, the staged image record MUST replace `image-packages.json`
in the same run, because the record names the image that the new catalog
was proven beside, and a kept record would describe an older image beside
a newer catalog.

#### Scenario: A repeat download is a no-op

- **GIVEN** a valid receipt at the current tag
- **WHEN** `store download` runs
- **THEN** nothing transfers, and the state reports complete

#### Scenario: The update replaces the graph whole

- **GIVEN** a moved tag and the `--update` flag
- **WHEN** the merge completes
- **THEN** the new `deps.json` replaces the old one, and no node-level merge happens

#### Scenario: The update replaces the catalog farm

- **GIVEN** a moved tag and the `--update` flag
- **WHEN** the merge completes
- **THEN** `farms/catalog` holds the staged catalog farm, and each farm of an analysis is untouched

#### Scenario: The update replaces the image record

- **GIVEN** a moved tag, the `--update` flag, and a store root with an older `image-packages.json`
- **WHEN** the merge completes
- **THEN** the store root holds the staged `image-packages.json`, and the older record is gone

#### Scenario: A plain download keeps the present record

- **GIVEN** a store root with an `image-packages.json` and a download without `--update`
- **WHEN** the merge completes
- **THEN** the present record is untouched

### Requirement: The cancel drops the staged tree only after the child is gone

`store cancel` MUST signal the live child and wait, with a bound. When the
child frees its lock inside the bound, the cancel removes the staged tree
and settles `canceled`. When the child still holds the lock at the bound,
the cancel MUST keep the staged tree and MUST name the live holder. The
reason: a removal under a live writer can tear a rename mid-flight, and a
torn merge can read back as a complete local store. A kept tree costs
nothing — the next run merges it or repairs it through the receipt.

#### Scenario: A stopped child frees the staged tree

- **GIVEN** a live catalog transfer whose child exits on the signal
- **WHEN** `store cancel` runs
- **THEN** the staged tree is removed, and the row settles `canceled`

#### Scenario: A child that outlives the bound keeps the staged tree

- **GIVEN** a child that still holds the transfer lock at the wait bound
- **WHEN** `store cancel` returns
- **THEN** the staged tree stays, the row stays live, and the answer names the holder
