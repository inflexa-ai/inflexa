## ADDED Requirements

### Requirement: Citation resolution accepts evidence-preserving inputs

The harness SHALL expose a host-agnostic `CitationResolver` with `resolveOne` and `resolveMany` operations. Each input SHALL carry the original `citation` string, SHALL accept an optional kind hint from `doi`, `pmid`, `arxiv`, `free_text`, or `auto`, and SHALL accept optional caller-supplied title, authors, year, venue, volume, and first-page fields. The resolver SHALL preserve the original input in its result and SHALL compare only metadata fields supplied by the caller.

#### Scenario: Identifier-only input preserves its evidence

- **WHEN** the caller resolves a DOI string without supplying metadata
- **THEN** the result contains the original citation and normalized DOI
- **AND** no title, author, year, venue, volume, or page field is reported as matched or mismatched

#### Scenario: Supplied metadata is compared without being replaced

- **WHEN** the caller resolves a raw citation with supplied title and year
- **THEN** the result retains those exact supplied values and returns separate field comparisons for title and year
- **AND** metadata returned by a source does not become caller-supplied evidence for any absent field

### Requirement: Source applicability is determined before lookup

The resolver SHALL compute a deterministic source plan from normalized input and SHALL invoke only applicable operations. The plan SHALL support DOI handle/RA/metadata lookup for an exact DOI, exact PubMed retrieval for PMID, exact arXiv retrieval for arXiv id, DOI or structured PubMed search when enough signal exists, bounded arXiv search only for indicated preprints, Crossref bibliographic matching, and Semantic Scholar identifier or bounded bibliographic lookup. Every source not selected by the plan SHALL produce a `not_applicable` outcome without a network request.

#### Scenario: PMID does not fan out indiscriminately

- **WHEN** the input is an exact PMID with no other metadata
- **THEN** PubMed exact retrieval is applicable
- **AND** inapplicable raw-bibliographic source operations make no request and return `not_applicable`

#### Scenario: ECitMatch requires useful structured input

- **WHEN** a citation contains unparsed prose but no extracted journal or other structured fields
- **THEN** the resolver does not invoke PubMed ECitMatch
- **AND** any bounded raw PubMed query is labelled candidate generation rather than exact citation matching

### Requirement: DOI identity is registration-agency-neutral

For an exact DOI, the resolver SHALL check DOI handle existence and obtain the responsible registration agency without assuming Crossref ownership. It SHALL request machine-readable metadata through DOI content negotiation, but SHALL represent handle existence separately from metadata availability. It SHALL query Crossref as the exact registration source only when the DOI is Crossref-owned.

#### Scenario: Non-Crossref DOI resolves

- **WHEN** a valid DOI owned by another registration agency resolves through the DOI handle service
- **THEN** the result records that the identifier exists and names that registration agency
- **AND** absence from Crossref does not produce `not_found`

#### Scenario: DOI exists without supported negotiated metadata

- **WHEN** the DOI handle resolves but its registration agency returns no supported metadata representation
- **THEN** identifier existence is present in the result
- **AND** requested metadata comparisons remain incomplete instead of being reported as matches

### Requirement: Every source returns a uniform outcome

Each configured source SHALL return one outcome with source name, attempted operation, request count, zero or more source-labelled records, optional detail, and status `ok`, `no_data`, `unavailable`, or `not_applicable`. HTTP failure, rate-limit exhaustion, timeout, and malformed upstream payload SHALL become `unavailable` for that source while preserving outcomes from other sources. Invalid public input, invalid resolver configuration, and caller cancellation SHALL remain operation failures rather than source outcomes.

#### Scenario: One source fails while another resolves

- **WHEN** Crossref is unavailable and PubMed returns a qualifying record
- **THEN** the result retains Crossref as `unavailable` and the PubMed record as `ok`
- **AND** the Crossref failure does not discard the PubMed evidence

#### Scenario: Cancellation aborts the operation

- **WHEN** the caller's abort signal fires during resolution
- **THEN** outstanding source requests and limiter waits stop promptly
- **AND** the resolver rejects with cancellation rather than returning an `unavailable` source outcome

### Requirement: Records are clustered without hiding disagreement

The resolver SHALL normalize strong identifiers and cluster records describing the same work before comparison. A record lacking a shared strong identifier SHALL join a cluster only when bounded bibliographic similarity exceeds the configured candidate threshold. Related versions such as a preprint and journal article SHALL remain distinct and SHALL carry their relation. Conflicting source fields SHALL remain source-labelled in the result and SHALL NOT be silently overwritten by a preferred source.

#### Scenario: Sources disagree about a resolved work

- **WHEN** two sources return the same DOI with materially different titles or years
- **THEN** they occupy the same identity cluster and the field conflict is explicit
- **AND** both source values remain available to the caller

#### Scenario: Weak candidates do not become a match

- **WHEN** the highest raw-citation candidate is below the match threshold or is not sufficiently separated from the runner-up
- **THEN** the resolver selects no record
- **AND** it retains the candidate diagnostics without reporting `verified`

### Requirement: Field comparison is deterministic and bounded to supplied fields

The resolver SHALL apply versioned deterministic comparison rules for title, authors, year, venue, volume, and first page. Each supplied field SHALL receive `match`, `mismatch`, or `not_compared` with the compared source values and rule version. Material normalization SHALL be limited to documented Unicode, case/punctuation, author-token, year, volume, and page rules.

#### Scenario: Material supplied metadata differs

- **WHEN** an exact identifier resolves but the supplied title materially differs from every record title
- **THEN** the title comparison is `mismatch` and includes the supplied and source values

#### Scenario: Missing source metadata cannot agree

- **WHEN** the caller supplied a venue but the selected record has no comparable venue metadata
- **THEN** the venue comparison is `not_compared`
- **AND** the resolver does not infer a match from the identifier alone

### Requirement: Verdict and coverage are independent contracts

The resolver SHALL return exactly one verdict from `verified`, `metadata_mismatch`, `not_found`, `unverifiable`, or `inconclusive`, and SHALL separately return coverage `complete`, `partial`, or `none`. It SHALL derive `verified` only from a selected record whose supplied fields all match; `metadata_mismatch` from a selected record with at least one material mismatch; `not_found` only when every applicable source completed and none returned a qualifying record; `unverifiable` only when the input itself establishes an unsupported work kind; and `inconclusive` for every remaining evidence gap.

#### Scenario: Complete negative coverage yields not found

- **WHEN** every applicable source responds successfully and none returns a qualifying record
- **THEN** the verdict is `not_found` and coverage is `complete`

#### Scenario: Source outage prevents not found

- **WHEN** no source establishes a record and at least one applicable source is unavailable
- **THEN** the verdict is `inconclusive`
- **AND** coverage is `partial` or `none`, never `complete`

#### Scenario: Existing DOI has incomplete requested metadata

- **WHEN** a DOI handle exists but supplied metadata cannot be compared because metadata retrieval was unavailable
- **THEN** the verdict is `inconclusive`
- **AND** the result separately records identifier existence and incomplete field comparisons

#### Scenario: Unsupported work kind is explicit

- **WHEN** the input explicitly describes a personal communication without a supported identifier
- **THEN** the verdict is `unverifiable`
- **AND** the resolver does not relabel an ordinary unsuccessful search as `unverifiable`

### Requirement: Batch resolution is bounded and deduplicated

`resolveMany` SHALL preserve input order in its returned results while deduplicating identical normalized identifiers and raw citations. It SHALL coalesce in-flight duplicates, use applicable batch endpoints only when results map unambiguously to inputs, enforce per-source concurrency and request-rate limits, bound retries and retry delay, honor `Retry-After` within that bound, and maintain a bounded in-memory cache. It SHALL NOT persist citation data.

#### Scenario: Duplicate bibliography entries share work

- **WHEN** a batch contains repeated forms of the same normalized DOI
- **THEN** the resolver performs one in-flight lookup for that DOI
- **AND** returns one result at every original input position

#### Scenario: Bibliography batch respects source bounds

- **WHEN** a batch contains more entries than a source's concurrency and rate limits
- **THEN** source requests remain within both configured limits
- **AND** the resolver does not launch one simultaneous request per entry

#### Scenario: Unavailable outcomes are not retained as negative cache entries

- **WHEN** a source returns `unavailable` for an input and that input is resolved again after the in-flight operation ends
- **THEN** the resolver is permitted to request that source again immediately
- **AND** the prior outage is not served as cached `no_data`

### Requirement: Network disclosure is explicit

Resolution SHALL transmit only the supplied identifier, structured citation fields, or raw citation string needed by an applicable authority. It SHALL NOT transmit surrounding document prose, claims, or results. The service SHALL NOT claim that citation strings are non-sensitive, and callers that require approval SHALL obtain it before invoking the resolver.

#### Scenario: Raw citation lookup sends bounded content

- **WHEN** an approved caller resolves a raw bibliography entry
- **THEN** applicable authorities receive that citation query
- **AND** no surrounding manuscript paragraph is included by the resolver
