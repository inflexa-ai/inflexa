## ADDED Requirements

### Requirement: A download plan names its source, its request, and each item

The harness MUST publish the `AcquisitionPlan` type and a zod schema for it
through its root barrel. A plan MUST carry these values:

- the source: its name, its base URL, and its release
- the request, as text in the form that the source defines
- a name, which is one safe path segment
- one or more items

Each item MUST carry a path, an https URL, and a source identifier. An item
can also carry a size, and an md5 digest. The item path MUST obey the
safe-path rule of `ReferenceArtifactPathSchema`. The plan is not specific to
a source. The schema MUST refuse these plans:

- a plan with a URL that is not https
- a plan with two items that have the same path
- a plan whose name is not one safe path segment
- a plan with no item

#### Scenario: A path that leaves the directory

- **WHEN** a plan item has the path `../x.tsv`
- **THEN** the schema refuses the plan

#### Scenario: A URL that is not https

- **WHEN** a plan item has an `http://` URL
- **THEN** the schema refuses the plan

#### Scenario: Two items with one path

- **WHEN** two plan items have the same path
- **THEN** the schema refuses the plan

### Requirement: The embedder realizes the input-acquisition seam

The harness MUST publish the `InputAcquirer` seam through its root barrel.
The seam has a `maxBytes` value and an `acquire` operation. `acquire` takes
a plan, the session of the tool call, and an abort signal. It returns the
acquired input or an `AcquisitionError`. The errors are `too_large`,
`destination_exists`, `digest_mismatch`, `transfer_failed`, `refused`, and
`aborted`.

`ConversationAgentDeps` MUST carry the seam as the optional field
`inputAcquirer`. The harness MUST NOT write a downloaded byte itself.

#### Scenario: The harness gives the session and the signal

- **WHEN** `download_gdc_data` calls the seam
- **THEN** the call carries the plan, the session of the tool context, and
  the abort signal of the tool context

### Requirement: A realization adds all the items or nothing

A realization of the seam MUST obey these rules:

- It MUST refuse a plan whose declared bytes are more than `maxBytes`,
  before it moves a byte.
- It MUST refuse a plan whose input directory exists already, with
  `destination_exists`.
- It MUST make sure that the md5 of each item with a digest agrees with the
  digest of the plan.
- It MUST calculate the SHA-256 hash of each item.
- If one item fails, it MUST add no input, and it MUST delete each partial
  file.
- If the signal aborts, it MUST stop, delete each partial file, and return
  `aborted`.

#### Scenario: A digest does not agree

- **WHEN** the md5 of one downloaded file does not agree with the plan
- **THEN** the realization returns `digest_mismatch`, it adds no input, and
  no file of the plan stays on the disk

#### Scenario: The user stops the turn

- **WHEN** the signal aborts during the transfer
- **THEN** the realization returns `aborted`, and no file of the plan stays
  on the disk

### Requirement: A realization records the origin with the input

After each item arrives and agrees with its digest, a realization MUST do
these steps:

1. Write a receipt beside the files. The receipt holds the plan, and the
   SHA-256 hash and the size of each item.
2. Add the directory as one input of the analysis of the session.
3. Record the origin with the `input_acquired` event of
   `@inflexa-ai/prov-kernel`, before the `input_added` event of the same
   input.

Each file row of the origin record MUST carry the analysis-relative path
that a step read of that file records. Thus a later step read joins the
downloaded file in the provenance.

#### Scenario: A completed download

- **WHEN** each item of a plan arrives and agrees with its digest
- **THEN** the analysis has one new input, and the receipt is in that input
- **AND** the provenance holds the `input_acquired` record before the
  `input_added` record of that input

#### Scenario: A step reads a downloaded file

- **GIVEN** a completed download
- **WHEN** a step reads one of the downloaded files
- **THEN** the file entity of that read is the file entity of the origin
  record
