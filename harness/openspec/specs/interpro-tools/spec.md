# interpro-tools Specification

## Purpose

Defines the harness tool `get_protein_domains`, which reads the REST API of
InterPro (`https://www.ebi.ac.uk/interpro/api/`). InterPro integrates the
signatures of Pfam, PROSITE, SMART, CDD, PANTHER, and other member databases
into InterPro entries
([Blum and others, NAR 2025](https://academic.oup.com/nar/article/53/D1/D444/7907824)).
The type of an entry is, for example, `family`, `domain`, `repeat`, or
`active_site`. The tool gives the domain architecture of one protein. Each entry
carries its type, its member signatures, and its residue ranges on the sequence.

The tool is a `defineTool` wrapper over the InterPro client
(`harness/src/tools/lib/interpro-client.ts`). The client uses the shared
`apiFetchText` boundary. An expected outcome is a data variant. `execute`
throws an unexpected failure, and the agent loop records it as
`tool_result { is_error: true }`. The tool never returns a `{ success, error }`
envelope.

InterPro answers an accession with no entry with HTTP 204 and an empty body.
`apiFetch` parses JSON after each 2xx status, and the parse of an empty body
fails. Then `apiFetch` retries the request until the retries are exhausted, and
`isUnexpectedApiError` reports the result as unexpected. Thus the client reads
the body as text. An empty body gives the empty result, and the client
validates a non-empty body against its own schema.

The 204 of InterPro also holds the header `Content-Length: 119`. An HTTP/1.1
fetch reads the 204, for example the fetch of Bun and the fetch of Node 24. The
HTTP/2 fetch of Node 26 refuses the header as a protocol error before it gives
a status. On that runtime, the call fails as a transport failure, and the tool
reports an error. The client never reads a transport failure as an absence.

The tool is a script tool of the conversation agent, and an agent calls it
through `run_script`. Thus the tool declares an output schema, and the catalog
of `run_script` shows its result type.

## Requirements

### Requirement: The get_protein_domains tool takes a UniProt accession

The system MUST give one harness tool, `getProteinDomainsTool`
(`harness/src/tools/bio/get-protein-domains.ts`), with the on-wire id
`get_protein_domains`, built with `defineTool`. The input is an object with a
UniProtKB accession (`uniprotAccession`) and the optional `limit` and
`maxLocations`. The schema MUST remove the white space around the accession. The
schema MUST refuse an empty accession before `execute` runs.

#### Scenario: The input schema is an object

- **WHEN** the tool emits the JSON schema of its input
- **THEN** the schema has a top-level `"type": "object"`

#### Scenario: An empty accession is refused

- **WHEN** an agent calls the tool with `uniprotAccession: "  "`
- **THEN** the input validation refuses the call, and `execute` does not run

### Requirement: The tool gives the InterPro entries of the protein

The tool MUST return `ok({ uniprotAccession, domains, totalFound })`. Each entry
of `domains` carries `accession`, `name`, `type`, `memberDatabases`,
`locations`, and `locationCount`. The value of `memberDatabases` maps each
member database to its signature accessions, and each signature accession to
its name.

Each range of `locations` holds the `start` and the `end` of one fragment. The
positions are 1-based and inclusive. The ranges of an entry are in sequence
order. The entries are in the order of their first residue.

The client MUST read one page, and `limit` (default 50, max 200) is the page
size. `totalFound` gives the `count` of InterPro, which is the true total.
`maxLocations` (default 20, max 1000) trims the ranges of each entry.
`locationCount` gives the count of the ranges before the trim.

#### Scenario: A known accession gives InterPro entries

- **WHEN** an agent calls the tool with `uniprotAccession: "P38398"`
- **THEN** each entry has an accession that starts with `IPR`, and the BRCT domain `IPR001357` has the ranges 1642 to 1736 and 1756 to 1855

#### Scenario: The limit is the page size

- **WHEN** an agent calls the tool with `limit: 3`
- **THEN** the request carries `page_size=3`, and `totalFound` gives the true count of InterPro

#### Scenario: The ranges of an entry are trimmed

- **WHEN** an entry has 8 ranges, and an agent calls the tool with `maxLocations: 3`
- **THEN** the entry holds the first 3 ranges, and `locationCount` is 8

### Requirement: An accession with no entry gives an empty result

The tool MUST return `ok({ uniprotAccession, domains: [], totalFound: 0 })` for
an HTTP 204 with an empty body. The tool MUST return the same value for an HTTP
404, which InterPro gives for a malformed accession. The client MUST NOT retry
a 204.

#### Scenario: An HTTP 204 gives an empty data variant

- **WHEN** InterPro answers HTTP 204 with an empty body
- **THEN** the tool returns `ok({ uniprotAccession, domains: [], totalFound: 0 })`, the client sends one request only, and the call is not an error

#### Scenario: An HTTP 404 gives an empty data variant

- **WHEN** InterPro answers HTTP 404 for a malformed accession
- **THEN** the tool returns `ok({ uniprotAccession, domains: [], totalFound: 0 })`

### Requirement: An unexpected failure is an error tool result

`execute` MUST throw an unexpected failure. These are unexpected failures:

- an HTTP error status that is not 404
- a timeout
- an exhausted retry
- a transport failure
- a payload that the schema refuses.

#### Scenario: A server error gives an error tool result

- **WHEN** InterPro answers with HTTP 500
- **THEN** `execute` throws, and the agent loop records the call as `tool_result { is_error: true }`

#### Scenario: A refused request is not an absence

- **WHEN** InterPro answers with HTTP 403
- **THEN** `execute` throws, and the error text holds the status

#### Scenario: A payload that the schema refuses

- **WHEN** InterPro answers HTTP 200 with a fragment `start` that is a string
- **THEN** `execute` throws, and the error text names the schema mismatch

### Requirement: The client obeys the absence policy of InterPro

A comment at the top of the client MUST name the absence policy of InterPro.
InterPro keeps the key of an absent value and sends an explicit `null`, for
example `integrated` and `go_terms` of an entry. The client schema MUST mark a
field that it reads and that can be absent as `.nullable()`, not `.optional()`.

#### Scenario: A payload with explicit nulls parses

- **WHEN** the payload for `P38398` carries `"integrated": null` and `"go_terms": null`
- **THEN** the schema parses the payload

### Requirement: The call detail names the accession

The `describeCall` hook MUST return the accession of the call.

#### Scenario: The detail of a call

- **WHEN** an agent calls the tool with `uniprotAccession: "P38398"`
- **THEN** the call detail is `P38398`

### Requirement: A script reads the result type

The tool MUST declare an `outputSchema`. The catalog of `run_script` MUST show
the result type of the tool, not `unknown`.

#### Scenario: The catalog shows the ranges

- **WHEN** the catalog of `run_script` lists `get_protein_domains`
- **THEN** the result type of the signature holds `locations: Array<{ end: number; start: number; }>`
