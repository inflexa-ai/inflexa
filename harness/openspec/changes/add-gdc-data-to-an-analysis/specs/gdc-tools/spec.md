## ADDED Requirements

### Requirement: The GDC client validates each response against the real API

The harness MUST send each GDC query through one client in
`src/tools/lib/gdc-client.ts`, with the base URL
`https://api.gdc.cancer.gov`. The client MUST use `apiFetchValidated`, and
it MUST send a `/files` row query as a POST with a JSON body. Each response
schema MUST obey `bio-api-schema-fidelity`. A field that the GDC can omit
MUST be optional in the schema. The golden tier MUST hold real payloads of
`/status`, a `/files` facet query, a `/files` row query, and a `/cases`
facet query.

#### Scenario: An absent clinical block is not a schema failure

- **WHEN** the GDC returns a case with no `demographic` block
- **THEN** the schema accepts the case, and the block is absent in the
  mapped result

#### Scenario: The release comes from the status endpoint

- **WHEN** the client reads `/status`
- **THEN** it returns the `data_release` text, for example
  `Data Release 46.0 - August 10, 2026`, and the major release number

### Requirement: search_gdc_data gives GDC metadata and downloads nothing

The harness MUST give a `search_gdc_data` tool. Each filter of the tool is
optional: the projects, the program, the primary site, the data category,
the data type, the workflow type, the experimental strategy, and the sample
types. The tool MUST return these values:

- the release
- the file count and the case count
- the facet counts for the data category, the data type, the workflow type,
  the experimental strategy, the sample type, and the access level
- the projects, when the request names no project, to a maximum of 50
- the vital-status counts of the cases, when the request names a project

The tool MUST NOT download a data file. An empty result MUST be an `ok`
result. The description MUST state that the tool gives metadata only and
that the sandbox has no network. The description MUST NOT name a download
tool.

#### Scenario: A project facet query

- **WHEN** the agent calls `search_gdc_data` with the project `TCGA-BRCA`
  and the data type `Gene Expression Quantification`
- **THEN** the result holds the release, the file count, the case count,
  the facet counts, and the vital-status counts
- **AND** no data file moves

#### Scenario: No project named

- **WHEN** the agent calls `search_gdc_data` with the program `TARGET` and no
  project
- **THEN** the result lists the TARGET projects with the name, the primary
  site, and the case count of each

#### Scenario: Nothing matches

- **WHEN** no file matches the filters
- **THEN** the tool returns an `ok` result with the file count 0

### Requirement: The GDC plan holds open-access files and their origin

The harness MUST make a download plan from a GDC request. The request names
one or more projects, an optional file selection, and a clinical flag. The
file selection names a data type, an optional workflow type, and optional
sample types. A request with no file selection and no clinical flag MUST be
refused.

The file filter MUST always include `access = open`. The builder MUST read
the file rows in pages of 5,000. The plan MUST hold these values:

- the source `GDC`, the base URL, and the release from `/status`
- the request, as the canonical JSON of the file filter and the clinical
  flag
- a name from the projects, the data type, and the major release
- one item for each file

Each file item MUST have the path `{file_id}/{file_name}`, the URL
`{baseUrl}/data/{file_id}`, the size, the md5 digest, and the file UUID as
the source identifier.

When the request has a file selection, the plan MUST hold a
`sample-sheet.tsv` item. The item is a `GET /files` query with `format=tsv`.
It gives the file id, the file name, the case id, the case barcode, the
sample barcode, and the sample type. When the clinical flag is set, the plan
MUST hold a `clinical.json` item. The item is a `GET /cases` query for the
projects, with the demographic, the diagnoses, the treatments, the
exposures, and the `follow_ups` records. A query item has no digest, and its
source identifier is its URL.

#### Scenario: A STAR count request

- **WHEN** the builder gets the project `TCGA-BRCA`, the data type
  `Gene Expression Quantification`, and the workflow type `STAR - Counts`
- **THEN** each file item is an open-access file of that type, with its
  UUID, its md5, and its size
- **AND** no controlled splice-junction file is in the plan

#### Scenario: A clinical-only request

- **WHEN** the builder gets the project `TCGA-BRCA`, no file selection, and
  the clinical flag
- **THEN** the plan holds one `clinical.json` item and no file item

#### Scenario: The sample sheet comes from the GDC

- **WHEN** the plan has a file selection
- **THEN** the plan holds a `sample-sheet.tsv` query item, and the harness
  makes no sample sheet itself

### Requirement: download_gdc_data asks before it downloads, and it reports each outcome as data

The `download_gdc_data` tool MUST make the plan before it asks. It MUST
return an `ok` result for each expected outcome:

- `nothing_matched`, when the plan holds no item
- `controlled_only`, with the count, when only controlled files match
- `too_large`, with the declared bytes and the ceiling, when the declared
  bytes are more than the `maxBytes` of the seam
- `downloaded`, with the input path, the file count, the bytes, and the
  release
- `failed`, with the error of the seam

The tool MUST ask the user with `ctx.ask` before it calls the seam. The ask
MUST name the file count, the size, and the release. It MUST also name the
projects, the data type, the workflow type, the sample types, and the
clinical flag. The ask MUST NOT carry a `grantKey`. The tool MUST give the session and the abort
signal of its context to the seam.

#### Scenario: The user approves

- **WHEN** the plan is inside the ceiling and the user approves once
- **THEN** the tool calls the seam one time, and it returns `downloaded`

#### Scenario: The user refuses

- **WHEN** the user rejects the ask
- **THEN** the tool does not call the seam, and the loop gives its denial
  result

#### Scenario: A plan above the ceiling

- **WHEN** the declared bytes of the plan are more than the `maxBytes` of
  the seam
- **THEN** the tool returns `too_large`, and it does not ask

#### Scenario: Only controlled files match

- **WHEN** no open file matches, and a controlled file matches
- **THEN** the tool returns `controlled_only` with the count, and it does not
  ask

### Requirement: The download tool exists only with the seam

The conversation agent MUST hold `search_gdc_data`. It MUST hold
`download_gdc_data` only when `ConversationAgentDeps.inputAcquirer` is set.
No other agent MUST hold `download_gdc_data`.

#### Scenario: An embedder with no seam

- **WHEN** an embedder builds the conversation agent with no `inputAcquirer`
- **THEN** the agent holds `search_gdc_data`, and it does not hold
  `download_gdc_data`

#### Scenario: An embedder with the seam

- **WHEN** an embedder builds the conversation agent with an `inputAcquirer`
- **THEN** the agent holds the two GDC tools

### Requirement: The planner searches the GDC and asks when the data is absent

The planner MUST hold `search_gdc_data`, and it MUST NOT hold
`download_gdc_data`. The planner prompt MUST name `search_gdc_data` in its
list of search cases. A question can ask about data that the inputs do not hold.
If the GDC holds that data, the prompt MUST tell the planner to call
`request_clarification`. The call names the data and the GDC project. The
prompt MUST tell the planner that no step downloads data.

#### Scenario: The planner finds absent survival data in the GDC

- **GIVEN** a request for a survival analysis of a TCGA-BRCA cohort, and
  inputs with no clinical data
- **WHEN** the planner confirms with `search_gdc_data` that the GDC holds
  the clinical records
- **THEN** the planner calls `request_clarification`, and it names the
  clinical data and the project `TCGA-BRCA`
