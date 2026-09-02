## MODIFIED Requirements

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
