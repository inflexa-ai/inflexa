# chembl-tools Specification

## Purpose

Defines the harness bio-lookup tool `chembl`, which wraps the ChEMBL REST API
(`https://www.ebi.ac.uk/chembl/api/data`) so agents can resolve compounds,
bioactivities, targets, mechanisms of action, and approved-drug records from a
single curated cheminformatics source. Its `action` is `compounds`, `drug`,
`mechanism`, `bioactivity`, or `targets`. The tool is a thin `defineTool`
wrapper over the shared pure-async client (`harness/src/tools/lib/chembl-client.ts`)
and the shared `apiFetch` boundary; the client owns mapping and the HTTP error
channel so the tool stays declarative.

The tools follow the harness tool-error contract: an expected ChEMBL outcome —
a `404` for an identifier that resolves to nothing — is returned as a data
variant (an empty array), never an error. An unexpected failure (5xx, timeout,
retry exhaustion, transport error) is thrown out of `execute`; the agent loop
catches it at the dispatch boundary and turns it into a `tool_result
{ is_error: true }`, so the tool itself never fabricates a `success` flag or
error envelope.

The on-wire tool id is `chembl` — that is the identifier the model sees and
calls. The exported TypeScript symbol is `chemblTool`. The tool is not handed to
every sandbox agent: it is an entry in the central sandbox tool registry (`resolveSandboxTools` in
`harness/src/agents/sandbox/shared.ts`) and reach a sandbox agent only when that
agent's `meta.tools` allowlist names it; it is also wired directly into the
conversation agent. It is deliberately absent from `BASE_SANDBOX_TOOLS`.

## Requirements

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

### Requirement: The drug action of the chembl tool

The drug lookup (the `drug` action of the `chembl` tool) MUST search approved drugs by name or by indication. It MUST return `ok({ drugs })` where each drug carries `moleculeChemblId`, `preferredName`, `maxPhase`, `moleculeType`, `firstApproval`, and `indication`.

A name query MUST run the molecule search filtered to `max_phase >= 4`. An indication query MUST run the `drug_indication` resource, with the `efo_term__icontains` and `mesh_heading__icontains` filters, and then resolve the molecules. The client MUST read the indications of the returned molecules from the `drug_indication` resource.

The client MUST NOT call `/drug/search.json`, because that endpoint does not exist on the ChEMBL API. The client MUST read `max_phase` as a wire number, because ChEMBL serializes it as the string `"4.0"`. `limit` MUST default to 10 (max 25).

#### Scenario: Search drugs by indication

- **WHEN** the `drug` action is called with `{ query: "melanoma" }`
- **THEN** it returns drugs with melanoma indications, with `maxPhase` and `firstApproval` as numbers

#### Scenario: Search drugs by name

- **WHEN** the `drug` action is called with `{ query: "imatinib" }`
- **THEN** it returns the approved molecules, with `preferredName` set and `maxPhase` equal to 4

#### Scenario: An approved row with a string max_phase parses

- **WHEN** the wire row carries `max_phase: "4.0"` and `pref_name: null`
- **THEN** the schema accepts the row, and the mapped drug carries `maxPhase: 4` and `preferredName: null`

### Requirement: ChEMBL tools are available via the per-agent allowlist

The ChEMBL tool `chembl` MUST be an entry in the central sandbox tool registry
that `resolveSandboxTools` (`harness/src/agents/sandbox/shared.ts`) resolves. It
reaches a sandbox agent only when the `meta.tools` allowlist of that agent names
it. It MUST also be a script tool of the conversation agent
(`harness/src/agents/conversation-agent.ts`), which calls it from `run_script`
(refer to the script-tools capability). It MUST NOT be a member of
`BASE_SANDBOX_TOOLS`, thus it is not granted to each sandbox agent.

#### Scenario: Sandbox agent resolves ChEMBL tools from its allowlist

- **WHEN** a sandbox-agent meta lists `chembl` in `meta.tools`
- **THEN** `createSandboxAgent` resolves it through `resolveSandboxTools` and adds it to the tool array of that agent

#### Scenario: ChEMBL tools are not granted by default

- **WHEN** the `meta.tools` of a sandbox agent does not name `chembl`
- **THEN** the resolved tool array does not contain `chembl`

#### Scenario: Conversation agent has the ChEMBL tools

- **WHEN** the conversation agent is created
- **THEN** its script tools include `chemblTool`, and its tools do not

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
