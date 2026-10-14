## ADDED Requirements

### Requirement: The CLI realizes the input-acquisition seam in the chat process

The CLI MUST give the harness `InputAcquirer` seam to the conversation agent
as `inputAcquirer`, from `runtime.ts`. The realization MUST run in the
process of the chat. It MUST find the analysis from the scope of the session,
and the anchor folder from the anchor of that analysis. If the session has
no analysis scope, it MUST return `refused`. If the process does not hold the
instance lock of the analysis, it MUST also return `refused`.

#### Scenario: A home chat has no analysis

- **WHEN** the harness calls the seam from a session with no analysis scope
- **THEN** the realization returns `refused`, and no file moves

#### Scenario: The chat of an analysis

- **WHEN** the harness calls the seam from the chat of an analysis that holds
  the lock
- **THEN** the realization downloads into the anchor folder of that analysis

### Requirement: A download lands in a new directory of the analysis folder

The destination MUST be `{anchor folder}/{plan name}`. If the destination
exists, the realization MUST return `destination_exists`, and it MUST NOT
change the directory. `maxBytes` MUST be 32 GiB. The realization MUST return
`too_large` before it moves a byte when the declared sizes are more than
`maxBytes`.

The realization MUST download into a sibling staging directory,
`{destination}.incoming-{uuidv7}`. It MUST sweep the stale staging
directories of the same destination first. It MUST rename the staging
directory to the destination only after each item arrives and agrees with its
digest. It MUST remove the staging directory on each failure.

#### Scenario: The destination exists

- **GIVEN** a directory with the plan name in the anchor folder
- **WHEN** the realization gets the plan
- **THEN** it returns `destination_exists`, and the directory does not change

#### Scenario: One item fails

- **WHEN** one item fails after the retries
- **THEN** the realization returns the error of that item
- **AND** no staging directory and no destination directory stays on the
  disk

### Requirement: Each item is compared with its digest as it streams

The realization MUST download the items with a concurrency of 4. Each item
MUST use `downloadToFile`, with a retry on 403, 429, and 5xx. When the item
has an md5 digest, the realization MUST give it as `expectedMd5`.

`downloadToFile` MUST accept two optional fields:

- `expectedMd5`: it calculates the md5 from the stream. On a mismatch, it
  deletes the `.part` file and returns `digest_mismatch`.
- `signal`: it stops the fetch and the pipeline when the signal aborts. Then
  it deletes the `.part` file and returns `aborted`.

A caller that gives neither field MUST get the current behavior.

#### Scenario: A file that does not agree with its md5

- **WHEN** the bytes of an item do not agree with its md5
- **THEN** `downloadToFile` returns `digest_mismatch`, and the `.part` file
  is gone

#### Scenario: The user stops the turn

- **WHEN** the signal of the tool call aborts during the transfer
- **THEN** the realization returns `aborted`, and no staging directory stays
  on the disk

#### Scenario: A current caller

- **WHEN** `inflexa geo download` calls `downloadToFile` with no md5 and no
  signal
- **THEN** the transfer behaves as before this change

### Requirement: The download becomes one input with its origin

After the rename, the realization MUST add the destination as one input
through `addInputs`, with the acquisition callback. The callback MUST give
the origin record of the kernel `input_acquired` event:

- the source, the base URL, the release, and the request of the plan
- one row for each item, with the staged path, the SHA-256 hash, and the
  size
- in each row, the source identifier, the URL, and the md5 when the item has
  one

The staged path of each row MUST come from `stagedInputPath`. `stageInputs`
MUST use the same function. Before the rename, the realization MUST write
`acquisition-receipt.json` in the directory. The receipt holds the plan, the
time of the download, and the path, the bytes, and the SHA-256 hash of each
item. The receipt is not a row of the origin record. If `addInputs` fails or
adds no input, the realization MUST delete the destination and return
`refused`.

#### Scenario: A completed download

- **WHEN** each item arrives and agrees with its digest
- **THEN** the analysis has one new anchored input for the destination
- **AND** the bus receives `prov.input_acquired` and then `prov.input_added`
  for that input

#### Scenario: The origin path is the path of a step read

- **GIVEN** a completed download with the item `u1/counts.tsv` in the
  directory `gdc-tcga-brca-r46`
- **WHEN** the realization makes the origin row of that item
- **THEN** the row path is `data/inputs/local/gdc-tcga-brca-r46/u1/counts.tsv`
- **AND** `stageInputs` stages that file at the same path
