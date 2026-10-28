# Spec Delta

## RENAMED Requirements

- FROM: `### Requirement: search_pubmed tool`
- TO: `### Requirement: The search action of the pubmed tool`
- FROM: `### Requirement: get_article_details tool`
- TO: `### Requirement: The details action of the pubmed tool`
- FROM: `### Requirement: get_article_full_text tool`
- TO: `### Requirement: The fulltext action of the pubmed tool`

## MODIFIED Requirements

### Requirement: The search action of the pubmed tool

The system MUST give `createPubMedTool({ ncbiApiKey })` (`harness/src/tools/bio/pubmed.ts`), with the on-wire id `pubmed`, built with `defineTool`. `createNcbiTools(keys)` in `harness/src/tools/bio/keys.ts` builds it. The input is a flat object with an `action` of `search`, `details`, or `fulltext`. The schema refuses a call that does not give the argument of its action, before `execute` runs.

The `search` action searches PubMed through the E-utilities `esearch` and `esummary` endpoints. It takes `query` (PubMed syntax: MeSH terms, field tags, and Boolean operators), `maxResults` (default 10, max 50), `sort` (`relevance` or `date`, default `relevance`), and an optional `dateRange` of `{ from, to }` in the YYYY/MM/DD form. It MUST return `ok({ totalFound, results })`, where each result carries `pmid`, `title`, `journal`, `year`, and `authors`. The description of `query` MUST teach the PubMed query syntax (MeSH, `[Title/Abstract]`, `[Author]`, `[Gene]`, and the Boolean operators), thus the model writes an effective query.

#### Scenario: Basic keyword search

- **WHEN** the tool is called with `action: "search"`, `query: "BRCA1 breast cancer"`, and `maxResults: 5`
- **THEN** it returns `ok({ totalFound, results })` with up to 5 results, each having `pmid`, `title`, `journal`, `year`, and `authors`

#### Scenario: MeSH-qualified search with date range

- **WHEN** the tool is called with `action: "search"`, a MeSH query, `sort: "date"`, and `dateRange: { from: "2023/01/01", to: "2024/12/31" }`
- **THEN** it returns date-sorted results within the range, each with the standard fields

#### Scenario: No results found

- **WHEN** the query of a `search` matches no articles
- **THEN** it returns `ok({ totalFound: 0, results: [] })`

#### Scenario: Upstream error surfaces as an error tool result

- **WHEN** the NCBI API fails (5xx, timeout, or retry exhaustion)
- **THEN** `execute` throws and the agent loop records the call as `tool_result { is_error: true }`

#### Scenario: A call without the argument of its action is refused

- **WHEN** the tool is called with `action: "fulltext"` and no `pmcId`
- **THEN** the input validation refuses the call with a message that names `pmcId`, and `execute` does not run

### Requirement: The details action of the pubmed tool

The `details` action of the `pubmed` tool fetches the metadata of a batch of PMIDs through `efetch` (XML). It takes `pmids` (a string array, min 1, max 20), `maxAuthors` (default 5), and `maxMeshTerms` (default 10). It MUST return `ok({ articles, notFound })`, where each article carries `pmid`, `title`, `abstract`, `authors`, `authorCount`, `journal`, `year`, `doi`, `meshTerms`, `meshTermCount`, and `pmcId` (a string or null).

`authors` and `meshTerms` keep the leading entries up to `maxAuthors` and `maxMeshTerms`. `authorCount` and `meshTermCount` give the full counts. `pmcId` MUST come from the NCBI ID Converter (`idconv`), which the action calls in parallel with `efetch`. Each PMID with no returned article MUST be in `notFound`.

#### Scenario: Batch detail retrieval

- **WHEN** the tool is called with `action: "details"` and three valid PMIDs
- **THEN** it returns `ok({ articles, notFound })` with details for all three, each including `abstract`, `authors`, `meshTerms`, `doi`, and `pmcId`

#### Scenario: Mixed PMC availability

- **WHEN** some PMIDs have PMC full text and others do not
- **THEN** articles in PMC have a non-null `pmcId` (for example `"PMC1234567"`) and the rest have `pmcId: null`

#### Scenario: Invalid PMID in batch

- **WHEN** the tool is called with `action: "details"` and a mix of valid and invalid PMIDs
- **THEN** valid articles are returned in `articles` and unmatched PMIDs appear in `notFound`

#### Scenario: Batch size exceeded

- **WHEN** the tool is called with `action: "details"` and more than 20 PMIDs
- **THEN** Zod input validation rejects the request before `execute` runs

#### Scenario: A long author list is cut to the cap

- **WHEN** an article has 40 authors, and the call gives no `maxAuthors`
- **THEN** the article carries the first 5 authors, and `authorCount` is 40

### Requirement: The fulltext action of the pubmed tool

The `fulltext` action of the `pubmed` tool fetches the open-access full text from PMC through `efetch` with `db=pmc`. It takes one `pmcId`, an optional `sections` filter, and an optional `maxChars` (default 12,000, min 500, max 200,000). The `sections` filter holds case-insensitive substrings of the section headings.

When the article is open-access, the action MUST return `ok({ pmcId, available: true, fullText, outline, totalChars, returnedChars, truncated })`. `fullText` holds each admitted section under its heading. A section that the filter matches is admitted whole, in document order, when it fits in the rest of `maxChars`. The first matched section is admitted also when it alone is larger than `maxChars`. `outline` lists each section of the article with its size and whether it came back. `truncated` is true when `returnedChars` is less than `totalChars`.

When the article is not available, the action MUST return `ok({ pmcId, available: false })`. Figure and table markup MUST stay out of the plain-text body.

#### Scenario: Successful full text retrieval

- **WHEN** the tool is called with `action: "fulltext"` and a valid `pmcId` of an open-access article
- **THEN** it returns `ok({ pmcId, available: true, fullText, outline, totalChars, returnedChars, truncated })`

#### Scenario: Article not available in PMC

- **WHEN** the `pmcId` does not resolve to an open-access article
- **THEN** it returns `ok({ pmcId, available: false })`

#### Scenario: A section filter narrows the body

- **WHEN** the tool is called with `action: "fulltext"` and `sections: ["methods"]`
- **THEN** `fullText` holds only the sections whose heading contains "methods"
- **AND** `outline` lists each section of the article, with `included: false` for each other section
