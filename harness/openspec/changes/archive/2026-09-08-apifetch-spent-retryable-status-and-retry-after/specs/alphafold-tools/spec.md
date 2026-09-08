## MODIFIED Requirements

### Requirement: AlphaFold DB structure prediction tool

The system MUST give an `alphafoldPredictionTool` (on-wire id
`alphafold_prediction`, built with `defineTool`) that takes a required
`uniprotAccession` string. For an accession with a model it MUST return
`ok({ found: true, uniprotAccession, uniprotDescription, latestVersion,
modelCreatedDate, globalMetricValue, fractionPlddtVeryLow, fractionPlddtLow,
fractionPlddtConfident, fractionPlddtVeryHigh, pdbUrl, cifUrl, paeImageUrl,
plddtDocUrl, paeDocUrl, amAnnotationsUrl? })`. For an accession with no model,
and for an identifier that does not parse, it MUST return
`ok({ found: false, uniprotAccession })`. The tool MUST trim the accession
before it makes the request, and the miss MUST echo the trimmed value.

#### Scenario: A canonical accession returns its model

- **WHEN** the tool is called with `uniprotAccession: "P69905"` (hemoglobin subunit alpha)
- **THEN** it returns `ok({ found: true, ... })` with `globalMetricValue`, the four `fractionPlddt*` fields, and the artifact URLs

#### Scenario: A largely disordered protein reports its real mean pLDDT

- **WHEN** the tool is called with `uniprotAccession: "P38398"` (BRCA1)
- **THEN** `globalMetricValue` is below 50, and the tool description states that a low value reflects genuine disorder, not a failed prediction

#### Scenario: A padded accession echoes in its trimmed form

- **WHEN** the tool is called with `uniprotAccession: "  P38398  "` and AlphaFold holds no model for it
- **THEN** it returns `ok({ found: false, uniprotAccession: "P38398" })`

#### Scenario: A multi-isoform response is resolved to the queried accession

- **WHEN** AlphaFold answers with more than one entry for the same query — one per UniProt isoform
- **THEN** the tool selects the entry whose own `uniprotAccession` matches the queried accession, and falls back to the first entry when none match exactly

#### Scenario: An accession with no model returns found: false

- **WHEN** AlphaFold answers HTTP 404 for a well-formed accession it holds no model for
- **THEN** the tool returns `ok({ found: false, uniprotAccession })`, not an `is_error` tool result

#### Scenario: An identifier that does not parse returns found: false

- **WHEN** AlphaFold answers HTTP 400 for an identifier that is not a UniProt accession or an AlphaFold DB id
- **THEN** the tool returns `ok({ found: false, uniprotAccession })`, not an `is_error` tool result

#### Scenario: A server error surfaces as an error tool result

- **WHEN** AlphaFold returns a 5xx after retries are exhausted
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

#### Scenario: A throttle that outlives the retries surfaces as an error tool result

- **WHEN** AlphaFold returns 429 on every attempt
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`, not `ok({ found: false })`
