# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: ChEMBL tools wrap the ChEMBL REST API`
- TO: `### Requirement: The chembl tool wraps the ChEMBL REST API`
- FROM: `### Requirement: search_compounds tool`
- TO: `### Requirement: The compounds action of the chembl tool`
- FROM: `### Requirement: get_bioactivity tool`
- TO: `### Requirement: The bioactivity action of the chembl tool`
- FROM: `### Requirement: search_targets tool`
- TO: `### Requirement: The targets action of the chembl tool`
- FROM: `### Requirement: get_mechanism tool`
- TO: `### Requirement: The mechanism action of the chembl tool`
- FROM: `### Requirement: get_drug_info tool`
- TO: `### Requirement: The drug action of the chembl tool`

## MODIFIED Requirements

### Requirement: The chembl tool wraps the ChEMBL REST API

The system MUST give one harness tool, `chemblTool` (`harness/src/tools/bio/chembl.ts`), with the on-wire id `chembl`, built with `defineTool`. The input is a flat object with an `action` of `compounds`, `drug`, `mechanism`, `bioactivity`, or `targets`. The schema refuses a call that does not give the argument of its action, before `execute` runs. Each action sends server-side HTTP requests to the ChEMBL REST API through the shared client (`harness/src/tools/lib/chembl-client.ts`) and the shared `apiFetch` helper.

#### Scenario: Tools are importable with snake_case ids

- **WHEN** importing from `harness/src/tools/bio/index.js`
- **THEN** `chemblTool` is available
- **AND** its on-wire id is `chembl`

#### Scenario: A call without the argument of its action is refused

- **WHEN** the tool is called with `action: "mechanism"` and no `chemblId`
- **THEN** the input validation refuses the call with a message that names `chemblId`, and `execute` does not run

### Requirement: The compounds action of the chembl tool

The `compounds` action of the `chembl` tool searches compounds by a target, by a compound name, or by a SMILES substring. A required `searchType` of `target`, `compound`, or `smiles` selects the search. It MUST return `ok({ compounds })`, where each compound carries `chemblId`, `preferredCompoundName`, `canonicalSmiles`, `molecularWeight`, `alogp`, and `molecularFormula`. The `limit` MUST default to 25 (max 500).

The action MUST NOT sort the results again by relevance. They come back in the order that ChEMBL gives them. A `target` search takes a target name or a target ChEMBL ID, and it resolves the top target hit only. Its `limit` caps the activity rows that it scans, thus fewer unique compounds can come back.

#### Scenario: Search compounds by target

- **WHEN** the `compounds` action is called with `{ query: "EGFR", searchType: "target" }`
- **THEN** it resolves the target, fetches its activities, and returns the unique active compounds
- **AND** each result includes `chemblId`, `canonicalSmiles`, and `molecularWeight`

#### Scenario: Search compounds by name

- **WHEN** the `compounds` action is called with `{ query: "imatinib", searchType: "compound" }`
- **THEN** it returns compound(s) matching the name, each with its `canonicalSmiles`

#### Scenario: Result limit is honored

- **WHEN** the `compounds` action is called with `{ query: "EGFR", searchType: "target", limit: 100 }`
- **THEN** at most 100 activity records drive the molecule fan-out

### Requirement: The bioactivity action of the chembl tool

The `bioactivity` action of the `chembl` tool retrieves the bioactivity rows of a compound, a target, or an assay by ChEMBL ID. A required `idType` of `compound`, `target`, or `assay` names the column of the activity table that `chemblId` indexes. It MUST return `ok({ activities })`, where each activity carries `activityId`, `compoundChemblId`, `targetChemblId`, `standardType`, `standardValue`, `standardUnits`, `assayChemblId`, `assayType`, and `pchemblValue`. An optional `activityType` MUST filter by `standard_type`. `limit` defaults to 25 (max 500).

#### Scenario: Get bioactivity for a compound

- **WHEN** the `bioactivity` action is called with `{ chemblId: "CHEMBL25", idType: "compound" }`
- **THEN** it returns activity records, each including `standardType`, `standardValue`, and `standardUnits`

#### Scenario: Filter by activity type

- **WHEN** the `bioactivity` action is called with `{ chemblId: "CHEMBL203", idType: "target", activityType: "IC50" }`
- **THEN** only IC50 records are returned

#### Scenario: Read one assay back

- **WHEN** the `bioactivity` action is called with the `assayChemblId` of an earlier row and `idType: "assay"`
- **THEN** it returns the rows of that one assay

### Requirement: The targets action of the chembl tool

The `targets` action of the `chembl` tool searches biological targets by gene symbol, protein name, or ChEMBL ID. It MUST return `ok({ targets })`, where each target carries `targetChemblId`, `preferredName`, `targetType`, `organism`, and `geneNames`. `limit` MUST default to 10 (max 25).

#### Scenario: Search target by gene symbol

- **WHEN** the `targets` action is called with `{ query: "BRAF" }`
- **THEN** it returns target(s) matching BRAF, each with `targetChemblId`, `preferredName`, and `organism`

### Requirement: The mechanism action of the chembl tool

The `mechanism` action of the `chembl` tool retrieves the mechanism-of-action data of one molecule by ChEMBL ID. It MUST return `ok({ mechanisms })`, where each mechanism carries `mechanismOfAction`, `actionType`, `targetChemblId`, `targetName`, and `moleculeChemblId`. The target names MUST come from separate lookups of the targets, at most 5 at a time.

#### Scenario: Get mechanism for a drug

- **WHEN** the `mechanism` action is called with `{ chemblId: "CHEMBL941" }`
- **THEN** it returns the mechanism of action including `actionType` and the resolved target

### Requirement: Error handling, retry, and timeout

ChEMBL tools MUST treat a `404` as an expected "not found" and return an empty result array, not an error. The shared `apiFetch` boundary MUST retry `429`, `502`, `503`, and `504` with exponential backoff up to `maxRetries` (3, thus up to 4 attempts). It MUST apply a default request timeout of 90 seconds. When the response carries `Retry-After`, in seconds or as an HTTP date, the wait MUST be that value. Each wait, the server value included, MUST stay at or below `maxRetryDelayMs`, whose default is 30 seconds. A retryable status on the last attempt MUST resolve to the `exhausted` error, not to `http_status`, thus `isUnexpectedApiError` reads it as unexpected. Any unexpected failure — 5xx, timeout, or retry exhaustion — MUST be thrown out of `execute` so the agent loop wraps it as `tool_result { is_error: true }`. The tools do not return a self-authored error envelope.

#### Scenario: Target not found returns empty

- **WHEN** the `targets` action is called with a query that resolves to no target (404)
- **THEN** it returns an empty `targets` array, not an error

#### Scenario: Rate limit triggers backoff retry

- **WHEN** the ChEMBL API returns 429 or 503
- **THEN** `apiFetch` retries after exponential backoff up to 3 retries

#### Scenario: Retry-After sets the wait, under the cap

- **WHEN** the ChEMBL API returns 429 with `Retry-After: 2`, and `maxRetryDelayMs` is 50
- **THEN** `apiFetch` waits 50 milliseconds, then it retries

#### Scenario: A throttle that outlives the retries surfaces as an error tool result

- **WHEN** the ChEMBL API returns 429 on every attempt
- **THEN** `apiFetch` resolves to the `exhausted` error, `isUnexpectedApiError` gives true, and `execute` throws

#### Scenario: Server error surfaces as an error tool result

- **WHEN** the ChEMBL API returns a 5xx after retries are exhausted
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`
