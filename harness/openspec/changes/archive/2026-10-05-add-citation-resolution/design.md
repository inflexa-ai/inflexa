## Context

The harness currently exposes source-specific literature search and retrieval
tools. Those operations answer discovery questions, but there is no shared
operation that accepts a citation supplied by a user, resolves it against the
authorities that can contain it, compares supplied metadata, and distinguishes
absence from upstream failure.

Citation resolution crosses the conversation tool roster, the literature
reviewer, sandbox-agent allowlists, runtime dependency assembly, and external
API testing. Manuscript review also needs the same operation in a deterministic
workflow without fabricating a `ToolContext` or asking an LLM to invoke a tool.
The reusable boundary must therefore be a host-agnostic service; the agent-facing
tool is only one adapter over it.

The external sources have different applicability and authority. DOI resolution
can establish that a DOI handle exists regardless of registration agency, while
negotiated metadata is not guaranteed for every agency. PubMed is authoritative
for PMIDs and supports structured citation matching, arXiv is authoritative for
arXiv identifiers, and Crossref and Semantic Scholar are useful candidate
sources rather than universal identity authorities. Upstream rate limits and
outages are normal operational states.

## Goals / Non-Goals

**Goals:**

- Provide one typed `CitationResolver` service for single and bounded-batch
  resolution.
- Preserve the caller's citation and supplied fields as evidence while keeping
  normalized query material separate.
- Consult only sources applicable to the input and retain every source-labelled
  outcome.
- Produce deterministic field comparisons, coverage, conflicts, and one of five
  aggregate verdicts without treating an outage as absence.
- Bound concurrency, request rate, retries, and cache memory for bibliography-
  sized batches.
- Expose the service through conversation, literature-reviewer, and sandbox-agent
  tool surfaces while sharing one runtime configuration.
- Keep all external clients independently stub-testable and cover canonical real
  records through the existing opt-in integration-test convention.

**Non-Goals:**

- Determining whether a cited work supports a claim.
- Parsing arbitrary bibliography prose into lossless CSL metadata.
- Enforcing citation verification as a run-synthesis policy.
- Adding OpenAlex or dblp.
- Persisting a global citation cache or creating a new database table.
- Hiding citation strings from authorities when the caller opts into resolution.

## Decisions

### 1. The reusable boundary is a service, not a tool

`CitationResolver` exposes `resolveOne(input, options?)` and
`resolveMany(inputs, options?)`. It is constructed once by `assembleCoreRuntime`
from injected configuration and source clients. The `resolve_citation` tool is a
thin validation and presentation adapter. Deterministic workflows receive the
service directly and call it inside a named durable step.

This keeps tool-context concerns such as session provenance and chat emissions
out of the bibliographic core. The alternative—calling the tool from a workflow
or creating a synthetic `ToolContext`—would couple the workflow to an agent
surface and make cancellation, approval, and provenance ambiguous.

### 2. Inputs preserve evidence and normalize only for lookup

The public input carries the original citation string, an optional kind hint,
and optional supplied metadata. Normalization produces a separate internal form:
canonical DOI/PMID/arXiv identifiers, Unicode-normalized and whitespace-folded
text, normalized author tokens, and parsed year/page values. The original values
remain in the result and field comparisons.

Only fields present in the caller's input can participate in a metadata-match or
mismatch conclusion. Source-returned or model-recalled values never become
caller evidence. Identifier-only inputs may verify identity without pretending
that unspecified metadata was compared.

A pinned kind binds the whole pipeline, not just classification. `auto` would
have called a citation containing a DOI a DOI citation, so a caller who pins
`free_text` is overriding exactly that — and normalization extracts no
identifier for it. Extracting one anyway split the pipeline against itself: the
plan gave the citation bibliographic-only treatment while candidate scoring
short-circuited to a perfect score on an identifier no source had verified.

### 3. A source plan is computed before any request

A pure planner maps normalized input to source operations. Each source is marked
applicable or `not_applicable`, with an operation and bounded query:

- DOI: handle existence, RA lookup, and negotiated metadata for an exact DOI;
- PubMed: exact fetch for PMID, DOI search, or structured matching when enough
  extracted fields make the query useful;
- arXiv: exact fetch for arXiv id, or bounded search only when the input indicates
  a preprint;
- Crossref: DOI lookup for Crossref-owned records and bibliographic candidate
  search for raw/structured citations;
- Semantic Scholar: exact identifier lookup or bounded candidate search.

The planner has no network side effects and is unit-tested as the source-
applicability policy. Sending every input to every source was rejected because
it wastes quota, increases disclosure, and makes `not_found` semantics depend on
irrelevant authorities.

### 4. DOI identity and DOI metadata are separate operations

The DOI adapter first checks handle resolution and calls the DOI Foundation RA
service. It then requests preferred machine-readable metadata through content
negotiation. A resolving handle establishes identifier existence even when the
registration agency does not supply a supported metadata representation.

The result can therefore contain an existing DOI with unavailable metadata and
incomplete comparisons. Crossref is queried as the registration source only
when the RA result identifies Crossref; it is not used to declare non-Crossref
DOIs absent. Treating Crossref as the DOI registry was rejected because it
creates false negatives for other registration agencies.

The gate carries three states, not a nullable agency name. "DataCite owns this"
and "nobody could tell us" both leave the agency un-equal to Crossref, but only
the first is a finding, and collapsing them lets Crossref report ownership it
never established. Worse, it makes the skip look deliberate: an outcome of
`not_applicable` is excluded from coverage, so a DOI that neither the registry
nor Crossref ever checked could satisfy complete coverage and be declared
`not_found`. An undetermined agency is therefore `unavailable` — the honest
shape for a source that could not contribute — which keeps coverage partial and
the verdict inconclusive.

### 5. Source adapters return one common evidence shape

Every adapter returns a `SourceOutcome` with source name, status (`ok`,
`no_data`, `unavailable`, or `not_applicable`), operation, optional detail,
request count, and zero or more normalized records. A normalized record retains
its source-native identifiers and raw response fields needed for diagnostics.
Adapters translate HTTP failures, malformed payloads, and rate-limit exhaustion
to `unavailable`; these are data in the aggregate result, not thrown errors.

Programmer errors, invalid resolver configuration, caller cancellation, and
invalid public input still fail normally. This boundary prevents a transient
upstream failure from erasing results returned by other sources.

### 6. Candidates are clustered before metadata comparison

Records are clustered by strong normalized identifiers first (DOI, PMID, arXiv
id, then source-native corpus id). Records without a shared strong identifier
join a cluster only when bounded title/author/year similarity exceeds the
documented candidate threshold. Related-version links, such as a preprint and a
journal article, remain separate clusters with an explicit relation rather than
being merged into one record.

The selected cluster is the one established by an exact input identifier or,
for bibliographic input, the uniquely highest candidate above both a minimum
threshold and a separation margin. Ties or weak candidates do not become
verified records. Every conflicting source field remains in the result.

### 7. Comparisons and verdicts form a deterministic state machine

Field comparators are pure functions with versioned rules: case/punctuation and
Unicode normalization for titles/venues, set-aware author comparison, exact year
with an explicit online-first exception, and normalized volume/page comparison.
Each supplied field receives `match`, `mismatch`, or `not_compared` plus the
compared source values.

Author comparison cannot lean on surname position. Citation styles disagree
about it (`Smith, Jane A.`, `Jane A. Smith`, `Smith JA` all reach us) and the
comma that would settle it is gone by the time text is comparable, so the rule
works on the parts themselves: two names must share a part, must not each carry
a spelled-out part the other lacks, and — where both give a given name or
initial — those must agree. Surname-only agreement is a fallback for the one
case where nothing can contradict it, namely a side that supplies no given name.
Matching on surname alone would let `John Smith` verify against `Jane Smith`,
which for a bibliographic verification service is the failure that matters most.

The aggregate verdict is then derived without source-specific shortcuts:

1. A selected record plus all supplied fields matched yields `verified`.
2. A selected record plus any material mismatch yields `metadata_mismatch`.
3. Complete applicable coverage with no qualifying record yields `not_found`.
4. An input explicitly outside supported bibliographic authorities yields
   `unverifiable`.
5. Every remaining evidence gap yields `inconclusive`.

Coverage (`complete`, `partial`, or `none`) is derived independently from source
and comparison coverage. This permits an exact DOI to be known to exist while
requested metadata comparison remains inconclusive.

### 8. `resolveMany` owns bounded execution policy

The batch operation normalizes and deduplicates inputs before scheduling work.
Identical identifiers or normalized raw citations share an in-flight promise and
one cached round of source outcomes. Each source has a configurable token-bucket
limiter and small concurrency ceiling; batch endpoints are used only where their
response can be mapped back unambiguously. HTTP 429/503 retries are bounded,
jittered, cancellation aware, and honor `Retry-After` within a configured maximum
delay.

Pacing is an admission gate around the network call, not a wrapper around
`fetch`. The distinction is load-bearing: a limiter that queues *inside* the
fetch it replaces leaves the caller's timeout already running while the request
waits its turn, so on a source configured for one request per second a large
bibliography reports its own queue as upstream timeouts. The HTTP layer takes a
`schedule` seam, arms the timeout inside it, and re-enters it for each retry — so
one loop owns both the retry policy and the pacing that retry is subject to.

A source failure is that source's, not the batch's. A client that throws or
answers a batch with a result count its requests do not account for is reported
`unavailable` for those requests; the surrounding citations keep every other
source's evidence. Only caller cancellation still fails the operation.

What is cached is the round of source outcomes, keyed by the *lookup* an input
provokes and the source-plan version — for an exact identifier, the identifier
alone, since every operation an identifier plan selects is driven by it. Two
citations to one DOI that supply different metadata therefore share one round of
requests, and each is compared and judged against its own supplied values. The
comparison-rule version leaves the key with the comparisons, which are no longer
cached. Positive and negative entries have separate short TTLs; `unavailable` is
not cached beyond in-flight coalescing. A persistent cache was rejected because
it would require invalidation, privacy, and storage policy beyond this change.

### 9. Configuration is injected at the composition root

`CitationResolverConfig` contains source enablement, timeouts, concurrency/rate
limits, cache bounds, and optional Crossref contact identity. Source clients
receive an injected `fetch` for tests. The runtime does not read environment
variables or hardcode maintainer identity. When a contact is supplied, Crossref
requests identify it for polite access; otherwise they use public access.

The Semantic Scholar key reaches both the resolver and the discovery tool the
same way — through `BioToolKeys`, resolved at the embedder's composition root.
The discovery tool previously read `SEMANTIC_SCHOLAR_API_KEY` inside its
`execute`, which is the ambient read this boundary exists to prevent; the host
resolves the variable now, so the harness is configured rather than
environment-sensing.

The conversation tool, literature reviewer, sandbox tool resolver, and
manuscript workflow all close over the same service instance. This ensures one
process-wide pacing policy instead of a separate limiter per agent.

### 10. Tool exposure extends closed rosters explicitly

The resolver tool is added to the conversation agent and literature-reviewer
rosters. `resolve_citation` is also added to `SandboxToolName` and the exhaustive
sandbox resolver so agent metadata can name it. The tool returns the structured
resolver result without flattening source outcomes into prose; agent prompts
teach the difference between discovery and verification.

### 11. Tests split policy, adapters, aggregation, and live contracts

Unit tests cover normalization, source planning, clustering, comparison,
verdict/coverage derivation, limiter behavior, cache behavior, cancellation, and
each adapter with stubbed `fetch`. Integration tests follow the existing
external-API suite and auto-skip unless their required network/key conditions are
available. Canonical fixtures include a Crossref DOI, a DOI owned by another RA,
a PMID, an arXiv id, raw bibliographic matching, mismatch, no-match, conflicting
metadata, and one-source failure.

### 12. Authority wire clients are shared below discovery and verification

arXiv, Semantic Scholar, and PubMed each have one authority-owned source client
under `src/literature/sources`. That client owns endpoint construction, wire
schemas, response parsing, injected HTTP transport, timeout handling, and caller
cancellation. Literature-discovery tools and citation-resolution adapters are
separate consumers of the same client: tools retain their agent-facing search,
detail, and full-text contracts, while citation adapters retain applicability
planning and translation into `SourceOutcome` and `CitationRecord`.

Neither consumer may import the other. In particular, citation code does not
import parser functions from tool modules, and tools do not call the citation
resolver to perform discovery. DOI Registry and Crossref remain citation-only
authority adapters until another consumer needs their wire operations.

This preserves the real distinction between discovery and verification without
maintaining two URL builders, schemas, or parsers for the same upstream API.
Calling tools from deterministic resolver code was rejected because tool
envelopes and `ToolContext` are agent-surface concerns; keeping duplicate
citation clients was rejected because upstream contract changes could then be
implemented inconsistently.

## Risks / Trade-offs

- **[Bibliographic matching can select a plausible wrong work]** → Require a
  minimum score and separation margin, preserve all candidates, and return
  `inconclusive` rather than forcing a winner.
- **[Registration agencies expose uneven metadata]** → Separate handle existence
  from metadata coverage and retain `not_compared` fields.
- **[Rate limits can make batch latency high]** → Bound concurrency, honor
  upstream pacing, deduplicate, and expose partial coverage instead of creating a
  request storm.
- **[Source records legitimately disagree]** → Keep source-labelled fields and
  explicit conflicts; never silently overwrite by source priority.
- **[In-memory cache is process-local]** → Accept duplicate work across replicas;
  the alternative persistent cache has disproportionate privacy and migration
  cost for this capability.
- **[Raw citations may contain sensitive unpublished titles]** → Make network
  transmission explicit in the service/tool contract and require callers such as
  manuscript review to own approval before invocation.

## Migration Plan

This is additive. Add the service, clients, tool, roster entries, and runtime
configuration without changing existing literature-tool inputs or outputs. The
default runtime enables the no-key public sources with conservative limits; an
embedder may disable individual sources or supply Crossref contact identity.

Rollback removes the new roster entries and runtime dependency, after which no
existing stored data requires migration. There is no database or artifact-format
migration.

## Open Questions

No implementation-blocking questions remain. Match thresholds, cache sizes, and
per-source rate limits are configuration defaults finalized in code and locked by
tests; changing them later does not alter the public verdict or coverage schema.
