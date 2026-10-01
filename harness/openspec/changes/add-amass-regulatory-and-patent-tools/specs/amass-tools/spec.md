## ADDED Requirements

### Requirement: An Amass client reads the Amass API

The harness MUST read the Amass API at `https://api.amass.tech/api/v1` through one client in `src/tools/lib/amass-client.ts`. The client MUST send the key in the header `Authorization: Bearer <key>`. Each request MUST go through `apiFetch` or `apiFetchValidated`.

The zod schemas MUST mirror the published OpenAPI document of Amass, with one exception. A response field that the document gives as an enum MUST be a plain string in the schema. Amass adds values to these lists, and one unknown value must not reject a whole response.

The file-top comment of the client MUST name the absence policy of Amass. A base field is present with an explicit `null`. An `include` field is an omitted key when the request does not ask for it.

#### Scenario: A request carries the Bearer key

- **GIVEN** a tool built with the key `amass_test`
- **WHEN** the tool sends a request
- **THEN** the request carries the header `Authorization: Bearer amass_test`

#### Scenario: An explicit null parses

- **WHEN** a RegulatoryCore record carries `therapeuticIndication: null`
- **THEN** the schema parses the record, and the mapped output gives `null` for that field

#### Scenario: An absent include field parses

- **WHEN** a RegulatoryCore search record carries no `fdaDetails` key and no `emaDetails` key
- **THEN** the schema parses the record

### Requirement: The Amass key is optional, and a call with no key fails terminally

`BioToolKeys` MUST have an optional `amass` field. `createAmassTools(keys)` in `src/tools/bio/keys.ts` MUST build the two Amass tools. It MUST give `keys.amass ?? ""` to each factory.

The harness MUST register each tool when the key is undefined or empty. With an empty key, `getAmassHeaders` in `src/tools/lib/amass-config.ts` MUST throw before a request goes to Amass. The error MUST name `AMASS_API_KEY` and `https://platform.amass.tech/api-keys`.

The description of each tool MUST give the key contract. With no key, the agent does not call again, tells the user, and continues without Amass data.

#### Scenario: An embedder omits the key

- **WHEN** an embedder gives a `BioToolKeys` value with no `amass` field
- **THEN** the harness compiles, and the conversation agent has the two Amass tools

#### Scenario: A call with no key

- **GIVEN** a tool built with an empty key
- **WHEN** its `execute` runs
- **THEN** it throws an error that names `AMASS_API_KEY`
- **AND** no request goes to Amass

### Requirement: search_regulatory_approvals searches the FDA and EMA authorizations

`createSearchRegulatoryApprovalsTool({ apiKey })` in `src/tools/bio/search-regulatory-approvals.ts` MUST make a tool with the id `search_regulatory_approvals`. Its input MUST be a flat object with an `action` field. The values of `action` MUST be `search`, `details`, and `section`, and the default MUST be `search`.

The `search` action MUST take `query` and these optional filters:

- `agency`
- `authorizationStatus`
- `moleculeType`
- `isOrphan`
- `hasDesignation`
- `minAuthorizationDate` and `maxAuthorizationDate`
- `amassId`, which limits the full-text search to the documents of one record

Each enum filter MUST accept only the values of the OpenAPI document. `limit` MUST have a default of 10 and a maximum of 20.

Each record of a `search` result MUST keep a maximum of 5 matched document sections: the first sections in the order of Amass. The record MUST also give the count of all its matched sections.

The kept sections MUST be in groups by source document. The groups MUST be in the order of their first section, and each group MUST keep the order of Amass. A group MUST give `docType`, `sourceUrl`, and `sourceDate` one time. A section entry MUST give only `documentSectionId`, `path`, `title`, and `matchedText`.

#### Scenario: A search gives compact sections

- **WHEN** Amass returns a record with 16 matched sections from one FDA label
- **THEN** the result gives 5 sections for that record, in one group, and the count 16
- **AND** no section entry carries `amassId`, `sourceUrl`, or `sourceDate`

#### Scenario: A limit above the maximum

- **WHEN** the agent sends `limit: 50`
- **THEN** the input schema rejects the call, and no request goes to Amass

#### Scenario: A search inside one record

- **WHEN** the agent sends `action: "search"` with a `query` and an `amassId`
- **THEN** the request to Amass carries both values

### Requirement: The regulatory details action resolves an identifier

The `details` action MUST take exactly one of `amassId`, `fdaApplicationNumber`, `emaProductNumber`, `ndc`, and `splSetId`. When the identifier is not an `amassId`, the tool MUST call the lookup endpoint first.

The tool MUST change two identifiers before the lookup:

- An FDA application number with no letter prefix MUST go as the `NDA`, `BLA`, and `ANDA` forms, as three items of one lookup request.
- An NDC with three hyphen segments MUST lose its third segment.

The tool MUST read a lookup item that carries `error.code: "NOT_FOUND"` as zero IDs. The result MUST have a `status` field:

- Zero IDs MUST give `status: "not_found"`.
- One ID MUST give `status: "found"` and the record.
- More than one ID MUST give `status: "ambiguous"` and the candidate Amass IDs. The tool MUST NOT get a record in this case.

The get request MUST ask Amass for `fdaDetails` and `emaDetails`. It MUST NOT ask for `referencesDrugCore`. The record MUST give the table of contents of its source documents in groups by source document. A section entry MUST give only `documentSectionId`, `path`, and `title`.

#### Scenario: A bare FDA application number

- **WHEN** the agent sends `fdaApplicationNumber: "021588"`
- **THEN** one lookup request carries `NDA021588`, `BLA021588`, and `ANDA021588`
- **AND** the result gives the record of the item that matched

#### Scenario: A package NDC

- **WHEN** the agent sends `ndc: "0078-0401-05"`
- **THEN** the lookup request carries `0078-0401`

#### Scenario: A lookup miss

- **WHEN** each item of the lookup response carries `error.code: "NOT_FOUND"`
- **THEN** the result gives `status: "not_found"`
- **AND** no get request goes to Amass

#### Scenario: An identifier with two records

- **WHEN** the lookup gives two Amass IDs for the identifier
- **THEN** the result gives `status: "ambiguous"` and the two IDs
- **AND** no get request goes to Amass

#### Scenario: An unknown Amass ID

- **WHEN** the get request for an `amassId` returns 404
- **THEN** the result gives `status: "not_found"`

### Requirement: The regulatory section action gives the full text of one section

The `section` action MUST take `amassId` and `documentSectionId`. It MUST give `status: "found"` and the section with `docType`, `path`, `title`, `sourceUrl`, `sourceDate`, and `content`. A 404 MUST give `status: "not_found"`.

#### Scenario: A section by its ID

- **WHEN** the agent sends `action: "section"` with an `amassId` and a `documentSectionId`
- **THEN** the result gives the full `content` of that section

### Requirement: search_patents searches patents

`createSearchPatentsTool({ apiKey })` in `src/tools/bio/search-patents.ts` MUST make a tool with the id `search_patents`. Its input MUST be a flat object with an `action` field. The values of `action` MUST be `search` and `details`, and the default MUST be `search`.

The `search` action MUST take `query` and these optional filters:

- `assignee` and `inventor`
- `cpcCodes` and `countryCode`
- the minimum and the maximum of the publication date, the filing date, the priority date, and the grant date

`limit` MUST have a default of 10 and a maximum of 20. A `search` request MUST NOT ask for `claims` or `description`.

The `details` action MUST take exactly one of `amassId`, `publicationNumber`, and `applicationNumber`. It MUST resolve the identifier and give `status` with the same rules as the regulatory `details` action. It MUST ask for `claims` only when `includeClaims` is true, and for `description` only when `includeDescription` is true. It MUST give the counts of the patent citations, and not the lists.

#### Scenario: A search gives no large text

- **WHEN** the agent sends `action: "search"`
- **THEN** the request to Amass asks for no `claims` and no `description`

#### Scenario: Details with claims

- **WHEN** the agent sends `action: "details"` with a `publicationNumber` and `includeClaims: true`
- **THEN** the get request asks for `claims`, and the result gives the claims text

#### Scenario: An application number with two publications

- **WHEN** the lookup gives two Amass IDs for an `applicationNumber`
- **THEN** the result gives `status: "ambiguous"` and the two IDs

### Requirement: Each Amass status maps to one outcome

The two tools MUST map each response of Amass to one outcome:

- A 404 from a get request, or a lookup item with `NOT_FOUND`, MUST give `ok` with `status: "not_found"`. The tool MUST write no `Logger` error record for it.
- A 400 or a 422 MUST give `err(ToolError)` with the message and the `fields` of Amass, and `retryable: false`.
- A 401 MUST make the tool throw. The message MUST tell the user to make sure that `AMASS_API_KEY` is correct.
- A 403 MUST make the tool throw with the message of Amass. The message MUST tell the user to make sure that the key is correct and that the organization has credits.
- Each other 4xx, and a lookup item with a different error code, MUST make the tool throw with the code and the message of Amass.
- A 429 after the last attempt, a 5xx, a timeout, or a schema rejection MUST make the tool throw.

A 401 or a 403 MUST NOT give `status: "not_found"` or an empty list.

#### Scenario: A bad key

- **WHEN** Amass answers a search with 401
- **THEN** the tool throws an error that names `AMASS_API_KEY`
- **AND** the tool does not give an empty result

#### Scenario: A semantically invalid input

- **WHEN** Amass answers with 422 and a message
- **THEN** the tool gives `err(ToolError)` that carries the message of Amass

#### Scenario: An undocumented 4xx

- **WHEN** Amass answers with 402 and a message
- **THEN** the tool throws an error that carries the code and the message of Amass

### Requirement: The conversation agent and the drug-repurposing agent get the Amass tools

The conversation agent MUST have `search_regulatory_approvals` and `search_patents`.

`SandboxToolName` MUST have `searchRegulatoryApprovals`, and the sandbox registry MUST map that name to the regulatory tool. `SandboxToolName` MUST NOT have a name for the patent tool. The two tools MUST NOT be members of `BASE_SANDBOX_TOOLS`.

The drug-repurposing agent MUST list `searchRegulatoryApprovals` in `meta.tools`. Its prompt MUST tell it when to use `search_regulatory_approvals`: for the authorization status of a candidate, its approved indications, its designations, and the safety sections of its label.

#### Scenario: The conversation agent has both tools

- **WHEN** the conversation agent is made
- **THEN** its tools include `search_regulatory_approvals` and `search_patents`

#### Scenario: The drug-repurposing agent has the regulatory tool only

- **WHEN** the drug-repurposing agent is made
- **THEN** its tools include `search_regulatory_approvals`
- **AND** its tools do not include `search_patents`

#### Scenario: A different sandbox agent does not get the tool

- **WHEN** a sandbox agent does not list `searchRegulatoryApprovals` in `meta.tools`
- **THEN** its tools do not include `search_regulatory_approvals`
