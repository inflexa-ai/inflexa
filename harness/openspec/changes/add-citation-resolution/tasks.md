## 1. Public Contracts and Normalization

- [x] 1.1 Add Zod schemas and exported TypeScript types for citation input, normalized records, source outcomes, field comparisons, conflicts, coverage, verdicts, and `resolveOne`/`resolveMany` results.
- [x] 1.2 Implement DOI, PMID, arXiv-id, raw-string, author, year, venue, volume, and page normalization while retaining every original caller value.
- [x] 1.3 Implement and unit-test the pure source-applicability planner, including exact-identifier paths, bounded bibliographic paths, and `not_applicable` outcomes.
- [x] 1.4 Add schema and normalization tests for identifier-only, raw, structured, malformed, and unsupported-work inputs.

## 2. Bibliographic Authority Adapters

- [x] 2.1 Implement the injected-fetch DOI adapter for handle existence, DOI Foundation RA lookup, and negotiated metadata with independent evidence states.
- [x] 2.2 Implement the injected-fetch Crossref adapter with exact/bibliographic lookup, optional polite identity, bounded result counts, and public-access fallback.
- [x] 2.3 Adapt PubMed exact PMID/DOI retrieval and structured ECitMatch requests without treating raw prose as ECitMatch input.
- [x] 2.4 Adapt arXiv exact-id and indicated-preprint bounded search into the common source-outcome shape.
- [x] 2.5 Adapt Semantic Scholar exact-identifier and bounded bibliographic search into the common source-outcome shape.
- [x] 2.6 Add stubbed-fetch tests for every adapter covering success, no data, malformed payload, timeout, rate limit, and cancellation.
- [x] 2.7 Extract one shared arXiv source client for URL construction, Atom parsing, injected transport, timeout, and cancellation; adapt discovery and citation consumers without changing their contracts.
- [x] 2.8 Extract one shared Semantic Scholar source client for wire schemas, URL construction, response parsing, injected transport, timeout, and cancellation; adapt discovery and citation consumers without changing their contracts.
- [x] 2.9 Extract shared PubMed/PMC source operations for E-utilities URLs, schemas, parsing, injected transport, timeout, and cancellation; adapt discovery and citation consumers without changing their contracts.
- [x] 2.10 Add shared-source regression tests and remove citation-to-tool imports and duplicate authority URL/schema/parser implementations.

## 3. Candidate Identity and Metadata Comparison

- [x] 3.1 Implement normalized strong-identifier clustering, bounded bibliographic candidate scoring, separation margins, and related-version links.
- [x] 3.2 Implement source-labelled field conflict detection without source-priority overwrites.
- [x] 3.3 Implement versioned pure comparators for title, authors, year, venue, volume, and first page with `match`/`mismatch`/`not_compared` output.
- [x] 3.4 Implement the deterministic five-verdict and independent three-coverage state machine.
- [x] 3.5 Add aggregation tests for exact matches, metadata mismatch, complete no-match, unsupported kind, source outage, weak/tied candidates, non-Crossref DOI, and conflicting records.

## 4. Bounded Batch Execution

- [x] 4.1 Implement per-source cancellation-aware concurrency and request-rate limiters with bounded `Retry-After` handling and injected timing for tests.
- [x] 4.2 Implement normalized-input deduplication, in-flight promise coalescing, applicable batch-endpoint mapping, and input-order reconstruction.
- [x] 4.3 Implement a bounded LRU with separate positive/negative TTLs and no post-flight caching of `unavailable` outcomes.
- [x] 4.4 Compose adapters, aggregation, comparison, and execution policy into `CitationResolver.resolveOne` and `resolveMany`.
- [x] 4.5 Add deterministic tests for concurrency ceilings, rate pacing, retry bounds, duplicate batches, cache expiry, batch mapping, and prompt cancellation.

## 5. Tool and Runtime Integration

- [x] 5.1 Implement the thin `resolve_citation` `defineTool` wrapper with flat validated input and the complete structured resolver result.
- [x] 5.2 Add `CitationResolverConfig` to runtime construction and assemble one shared resolver without ambient environment reads or hardcoded contact identity.
- [x] 5.3 Add the tool to the conversation-agent and literature-reviewer exact rosters and add roster regression tests.
- [x] 5.4 Update literature-reviewer guidance and tests to distinguish discovery from verification and preserve inconclusive coverage.
- [x] 5.5 Add `resolve_citation` to `SandboxToolName`, the exhaustive sandbox resolver, metadata validation tests, and unknown-name regression coverage.
- [x] 5.6 Export the public resolver contracts and construction types from the harness package entry point.

## 6. External Contract Coverage

- [x] 6.1 Add opt-in live integration cases for a Crossref DOI, non-Crossref DOI, PMID, arXiv id, and raw bibliographic match under the existing integration suite.
- [x] 6.2 Add live or canonical fixtures for no-match, supplied-metadata mismatch, and partial-source failure while preserving auto-skip behavior without preconditions.

## 7. Review Follow-Up

- [x] 7.1 Separate the rate-limit admission gate from the fetch so the HTTP layer arms its timeout after admission, and fold `Retry-After` retry into that one loop.
- [x] 7.2 Make author comparison surname-position independent and require given-name agreement where both sides supply one; bump the comparison rule version.
- [x] 7.3 Encode a DOI consistently across every registry, RA, metadata, and Crossref URL.
- [x] 7.4 Contain a throwing or inconsistent source client as `unavailable` for its own requests instead of failing the batch.
- [x] 7.5 Key coalescing and caching on the lookup an input provokes, and aggregate comparisons per caller.
- [x] 7.6 Export the full `CitationSourceClient` contract from the package entry point.
- [x] 7.7 Inject the Semantic Scholar key through `BioToolKeys` instead of reading it from the environment inside the tool.
- [x] 7.8 Add composed timeout/rate-limit, author-matching, source-containment, and shared-lookup tests.

## 8. Verification

- [x] 8.1 Format all changed harness source and test files with the subsystem formatter.
- [x] 8.2 Run focused citation resolver, tool-roster, sandbox-registry, and adapter tests and resolve failures.
- [x] 8.3 Run `tsc -p tsconfig.json`, `bun run lint`, and `bun run test:full` from `harness` and resolve regressions.
- [x] 8.4 Run `openspec validate add-citation-resolution --strict` and confirm every task-backed requirement remains represented.
