## Context

The harness has no tool for FDA or EMA authorizations, and no tool for patents. The proposal gives the reason for the change.

Amass gives both sources through one REST API:

- Each call must send a Bearer key. With no key, Amass returns `401 UNAUTHORIZED`.
- Amass lets each user send 60 requests in 60 seconds.
- A search returns a ranked set of a maximum of 300 records. The API has no pages.
- The documented error statuses are 400, 401, 403, 404, 422, 429, and 500.

Each call spends credits. The pricing page of Amass and live calls on 2026-09-30 give these facts:

- One credit is $0.01. Each response gives its cost in the `X-Amass-Credit-Cost` header.
- A search costs 5 credits for each 20 records of `limit`. A `limit` of 3 costs 5 credits, and a `limit` of 100 costs 25 credits.
- A get costs 1 credit. A 404 from a get also costs 1 credit.
- A lookup costs 1 credit for each request. A lookup of 4 identifiers costs 1 credit.
- The `credits` endpoint costs nothing. Only an organization admin can read it, and a member gets `403 FORBIDDEN`.

Comptox is the pattern for a key that a user can omit:

- `BioToolKeys` carries the key, and the embedder gives it (`src/tools/bio/keys.ts`).
- A header builder throws when the key is empty (`src/tools/lib/toxcast-config.ts`).
- The tool description tells the agent what to do after that error (`src/tools/bio/comptox.ts`).

`apiFetch` sends a request again after a 429, 502, 503, or 504 response. It obeys `Retry-After`, with a cap of 30 seconds on each wait (`src/tools/lib/api-utils.ts`).

`isUnexpectedApiError` reads each 4xx status as an expected absence. That rule is correct for a 404. It is not correct for a 401 or a 403.

## Goals / Non-Goals

**Goals:**

- Give the agents a search of the FDA and EMA authorizations and of the text of their labels.
- Give the agents a search of patents.
- Keep Inflexa the same for a user with no Amass key.

**Non-Goals:**

- The other four cores of Amass: BiomedCore, TrialCore, DrugCore, and GeneCore.
- The `changes` feeds and the `credits` endpoint.
- The configuration of the CLI. A separate change in `cli/` adds `bioKeys.amass`.
- A cache of Amass responses, or a budget of credits.

## Decisions

### D1. One tool for each core, with an `action` field

`search_regulatory_approvals` and `search_patents` each take a flat input object with an `action` field. `search_clinical_trials` and `pubmed` use the same shape. `defineTool` rejects a discriminated union at the top level.

Alternatives:

- One `amass` tool with a `core` field. The filters of the two cores are different. Thus one input object gets many fields that apply to one core only. Also, the name of a vendor does not tell the agent what the tool searches.
- One tool for each endpoint. That gives five tools for two sources, and the agent must connect a lookup to a get.

### D2. The tool resolves an external identifier

`details` takes one identifier field:

- `search_regulatory_approvals`: `amassId`, `fdaApplicationNumber`, `emaProductNumber`, `ndc`, or `splSetId`.
- `search_patents`: `amassId`, `publicationNumber`, or `applicationNumber`.

When the identifier is not an Amass ID, the tool calls the lookup endpoint first. Then it calls the get endpoint.

Amass stores two regulatory identifiers in one form only. The tool changes the input to that form before the lookup:

- **FDA application number.** Amass stores the number with its prefix, for example `NDA021588`. The bare number `021588` gives `NOT_FOUND`. When the input has no prefix, the tool sends the `NDA`, `BLA`, and `ANDA` forms as three items of one lookup. The three forms cost 1 credit, the same as one form.
- **NDC.** Amass stores the product NDC of two segments, for example `0078-0401`. The package NDC `0078-0401-05` gives `NOT_FOUND`. When the input has three segments, the tool removes the third segment.

Alternative: send the input with no change, and give the stored form in the tool description. A label and a paper often give the bare number and the package NDC. Thus the agent gets `NOT_FOUND` for a record that exists.

A lookup miss does not come as an HTTP error. The response is `200`, and the item carries `error.code: "NOT_FOUND"` with no `amassIds`. The tool reads that item as zero IDs.

The lookup can give zero, one, or more than one Amass ID:

- Zero IDs: the tool gives `found: false`.
- One ID: the tool gives that record.
- More than one ID: the tool gives the candidate Amass IDs, and it gets no record. The agent then calls again with one `amassId`.

On 2026-09-30, `NDA021588` resolved to one record. The API documents that a patent application number can resolve to more than one publication. Thus the third result is a normal result.

Alternative: get each candidate. For patents with claims, one result can then become very large. Also, each candidate then costs 1 credit.

### D3. Regulatory text comes in three sizes

- `search` gives, for each record, the document sections that matched the query. Each section carries the `matchedText` excerpt of Amass.
- `search` also takes an optional `amassId`. Amass then limits the full-text search to the documents of that one record.
- `details` gives the table of contents of the source documents, with no text.
- `section` gives the full text of one section by its `documentSectionId`.

The agent thus reads the excerpts first, then the table of contents, and then only the section that it must cite.

The raw responses are large. On 2026-09-30, a search for `imatinib` with a `limit` of 3 gave 25 KB. One of the three records carried 16 matched sections and 18 KB. The details of that record gave 47 KB, with 120 sections in the table of contents. Each section entry repeats `amassId`, `sourceUrl`, and `sourceDate`.

Thus the tool makes each result compact:

- The tool puts the sections into groups by source document. Each group gives `docType`, `sourceUrl`, and `sourceDate` one time.
- Each section entry gives only `documentSectionId`, `path`, and `title`. A search result also gives `matchedText`.
- A search result keeps the first 5 matched sections of each record, in the order of Amass, before the tool puts them into groups. It also gives the count of all matched sections.

Alternative: `details` gives the full text of each section. An FDA review has a large number of sections. Thus one result can become very large.

`details` asks Amass for `fdaDetails` and `emaDetails`, because the tool does not know the agency before the get. It does not ask for `referencesDrugCore`, because no tool reads a DrugCore ID.

### D4. Patent results leave out the large text

- `search` gives each patent with no claims and no description.
- `details` gives the claims when `includeClaims` is true, and the description when `includeDescription` is true.
- `details` gives the citation counts, and not the lists of citing patents.

The agent loop cuts a large result, and `read_tool_output` reads the remainder. Thus the tool does not cut the text itself.

### D5. Each status code maps to one outcome

- A 404 from a get, or a lookup item with `NOT_FOUND`, gives `found: false`. This is an expected outcome. The tool writes no error record.
- A 400 or a 422 gives a tool error with the message and the `fields` of Amass. The agent can then correct its input.
- A 401 makes the tool throw. The message tells the user to make sure that `AMASS_API_KEY` is correct.
- A 403 makes the tool throw with the message of Amass. The message tells the user to make sure that the key is correct and that the organization has credits.
- Each other 4xx, and a lookup item with a different error code, makes the tool throw with the code and the message of Amass.
- A 429 after the last attempt, a 5xx, a timeout, or a schema rejection makes the tool throw. `apiFetch` already gives these as unexpected errors.

Thus the client does not use `isUnexpectedApiError`. Only a 404 and a lookup `NOT_FOUND` are an absence.

Alternative: use `isUnexpectedApiError`, the same as the other clients. A bad key then gives `found: false` or an empty list. The agent then reports that the data does not exist.

### D6. The key contract obeys comptox

- `BioToolKeys` gets `amass?: string`. An undefined key and an empty key have the same effect.
- A new `createAmassTools(keys)` in `src/tools/bio/keys.ts` builds both tools. It gives `keys.amass ?? ""` to each factory.
- `getAmassHeaders(apiKey)` in `src/tools/lib/amass-config.ts` throws when the key is empty. The message names `AMASS_API_KEY` and `https://platform.amass.tech/api-keys`.
- Each tool description states the contract. With no key, the call fails terminally. The agent does not call again, tells the user, and continues without Amass data.

Alternative: return `not_configured` as data. That makes a change to the requirement "Key-gated tools are factory closures tested with and without a key". Comptox gives the same agent behavior with no change to a current requirement.

### D7. The agents that get each tool

- `src/agents/conversation-agent.ts` gives both tools to the conversation agent.
- `SandboxToolName` gets `searchRegulatoryApprovals` only, and the sandbox registry maps that name to the tool.
- The drug-repurposing agent lists `searchRegulatoryApprovals` in `meta.tools`.
- The drug-repurposing prompt gets one line on when to use the tool. The uses are the authorization status of a candidate, its approved indications, its designations, and the safety sections of its label.

Alternative: add `searchPatents` to `SandboxToolName` also. No sandbox agent uses it. Thus the name stays out of the closed list until an agent uses it.

### D8. The search limit

Each `search` takes `limit`, with a default of 10 and a maximum of 20. Amass permits 300.

- The maximum keeps each search at 5 credits. A `limit` of 21 costs 10 credits.
- The default keeps each result small, because D3 shows the size of one record. A `limit` of 10 costs the same as a `limit` of 20.
- The agent can narrow a query with the filters, because the API has no pages.

Alternative: a maximum of 50. One search can then cost 15 credits.

### D9. Schemas and fixtures

- The zod schemas in `src/tools/lib/amass-client.ts` mirror the published OpenAPI document of Amass, with one exception. A response field that the document gives as an enum is a plain string. Amass adds values to these lists, and one unknown value would reject a whole search. The input filters keep the enums of the document.
- The file-top comment of the client names the absence policy of Amass. A base field is present with an explicit `null`. An `include` field is an omitted key when the request does not ask for it.
- Live payloads on 2026-09-30 confirm the policy. `therapeuticIndication`, `grantDate`, and `fdaDetails.withdrawalDate` came as `null`. `fdaDetails` and `emaDetails` were absent from a search that did not ask for them.
- A live key verified the contract. Thus the client carries no marker for an unverified contract.
- The golden fixtures come from real responses, and a manifest records each capture.
- `scripts/refresh-fixtures.ts` sends no key. Thus a replay of an Amass entry fails with 401, the same as a replay of a comptox entry.
- Each replay of a search costs 5 credits. Thus the manifest holds one entry for each response shape, and not more.
- The integration tests under `src/providers/integration/` skip when `AMASS_API_KEY` is not set.

## Risks / Trade-offs

- [Two agents share the rate limit of one user] → A sandbox agent and the conversation agent can send calls at the same time. `apiFetch` obeys `Retry-After`, with the cap of 30 seconds. If Amass still refuses the call, the tool throws, and the agent continues without Amass data.
- [An agent loop spends the credits of the user] → A search costs $0.05, and a get, a lookup, or a 404 costs $0.01. The tools ask for no approval, the same as the other tools with a key. D8 keeps each search at 5 credits, and D2 keeps each identifier at one lookup.
- [PatentCore is a preview, and its contract can change] → The schema stays strict. Thus a change gives `invalid_response`, not a wrong result. The next fixture refresh also shows the change.
- [The API does not document the error for a spent credit balance] → D5 makes each 4xx other than 400, 404, and 422 terminal. The error gives the message of Amass. Thus the user sees the reason of Amass, whatever the status is.
- [A regulatory section can be very long] → The loop cuts the result, and `read_tool_output` reads the remainder.

## Migration Plan

1. Merge and publish the harness change. An embedder does not change, because the key field is optional.
2. The CLI change adds `bioKeys.amass`, and it bumps the harness pin.
3. To roll back, remove the tools from the two agents. No stored data refers to them.

## Open Questions

1. Which status does Amass send when the credits of an organization are spent? The documentation lists no status for it. To find the status, a call must spend the full balance of a key. Thus D5 covers each possible 4xx, and the question stays open.

Live calls on 2026-09-30 closed two questions:

- A standard key has access to PatentCore. A search returned `200`.
- `NDA021588` resolves to one RegulatoryCore record. D2 keeps the path for more than one ID, because the patent lookup documents that case.
