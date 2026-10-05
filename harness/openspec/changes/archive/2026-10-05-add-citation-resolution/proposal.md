# Resolve a citation against the record that would contain it

## Why

The harness can search four literature sources and cannot verify a single
citation. Retrieval and verification are different questions — "find me papers
about X" versus "does *this* reference exist, and is its metadata right" — and
only the first has an operation.

The cost of the missing second one is already sitting in run synthesis. A
synthesized `KeyReference` carries a `pmid` whose only guards are
`checkKeyReferencesCited` (`src/execution/run-synthesis.ts:167`, which checks
the id also appears under a finding) and `checkKeyReferencePmidFormat`
(`:199`, which is `PMID_PATTERN.test` — digits). Neither asks whether the record
exists. The remaining defence is prose inside a `.describe()`:
`src/schemas/run-synthesis.ts:116` says the pmid *"Must come from a
literature_reviewer response — never invented."* Nothing reads that back. A
fabricated id therefore reaches `synthesis.json`, the run-completed card, the
vector index, and the report — while the signed PROV document lends
content-hashed authority to everything around it. Provenance that is rigorous
about bytes and silent about assertions reads as verification it never
performed.

The near-term driver is manuscript review (`add-manuscript-review`), where the
bibliography arrives inside the user's document. Retrieval attestation — "this
identifier entered through a real tool call in this session" — is complete by
construction for citations the harness itself produced and is worth nothing for
a reference the harness never fetched. External resolution is the strictly
larger capability, and it is the only one that covers both cases.

This repository also contains the evidence for what such a verifier has to get
right. `paper/RELATED-WORK.md` §6 is a hand-built quarantine list from an actual
manuscript, and it separates four failure classes that a naive checker collapses
into one — including two cases where the *resolver* was wrong, not the author
(OpenAlex returned a corrupted DOI for BLOOM; bioRxiv returned a superseded
title for STELLA).

## What Changes

- New host-agnostic `CitationResolver` service with `resolveOne` and
  `resolveMany` operations, plus a thin `resolve_citation` tool wrapper. The
  service is the reusable capability: conversation and sub-agents reach it
  through the tool, while deterministic workflows such as manuscript review
  call `resolveMany` directly inside their own durable step. A workflow never
  constructs a fake `ToolContext` and never spends an LLM call merely to invoke
  the resolver.
- One citation input is a flat tool object carrying the original `citation`
  string, an optional `kind` hint (`doi`, `pmid`, `arxiv`, `free_text`, or
  `auto`), and optional supplied metadata (`title`, `authors`, `year`, `venue`,
  `volume`, `firstPage`). Identifier-only input verifies existence and identity;
  metadata comparison is performed only for fields the caller actually supplied.
  Field-code extraction can therefore pass clean metadata without making it a
  prerequisite for the plain-text case.
- Exact DOI lookup is registration-agency-neutral. The resolver checks the DOI
  handle, obtains the registration agency through the DOI Foundation's RA
  service, and requests metadata through DOI content negotiation. Identifier
  existence does not depend on the registration agency supporting CSL: when the
  handle resolves but negotiated metadata is unavailable, the response records
  the identifier as existing and leaves the requested metadata comparisons
  incomplete. It does not assume every valid DOI is registered with Crossref.
  Crossref remains the bibliographic matcher for raw references and the broad
  source for scholarly works outside biomedicine.
- New Crossref client (`api.crossref.org`, no key). An embedder may supply a
  contact email and user-agent through `CitationResolverConfig`; when present
  the client uses Crossref's polite pool, and when absent it uses the public pool.
  The harness never hardcodes a maintainer address and never reads one from an
  ambient environment variable.
- Resolution consults only the sources applicable to the input:
  - DOI registry metadata for an exact DOI;
  - Crossref bibliographic matching for raw or structured references;
  - PubMed exact retrieval for a PMID and DOI/field-based PubMed search when the
    input supplies enough signal;
  - arXiv exact retrieval for an arXiv id and bounded search when an arXiv
    preprint is indicated;
  - Semantic Scholar identifier lookup or bounded bibliographic search.
  PubMed `ecitmatch` is used only when extraction produced a valid structured
  request with a journal and enough additional fields for a useful constrained
  match; unused wire-format slots may remain empty. It is not described as an
  unparsed-reference API.
- arXiv, Semantic Scholar, and PubMed wire access is consolidated into one
  shared source client per authority. Existing discovery tools and the new
  citation adapters keep different public contracts, but both delegate URL
  construction, response validation/parsing, injected transport, timeouts, and
  cancellation to the shared authority client. Neither consumer imports the
  other.
- **Five-value verdict**, with coverage kept separate from the bibliographic
  conclusion:
  - `verified` — a record resolved, and every supplied metadata field agrees
    within the documented comparison rules. Identifier-only input can reach
    this verdict when the identifier resolves.
  - `metadata_mismatch` — a record resolved, but at least one supplied author,
    year, title, or venue field materially differs. The response carries
    field-level comparisons rather than only the aggregate verdict.
  - `not_found` — every applicable source answered successfully and none
    returned a candidate above the minimum match threshold.
  - `unverifiable` — the input itself identifies a work outside the supported
    authority set (for example a personal communication or an unregistered
    in-press item) and supplies no supported identifier. This verdict is never
    inferred merely because search returned nothing.
  - `inconclusive` — missing evidence prevents every stronger conclusion. This
    includes both "no source established a record and applicable coverage was
    incomplete" and "an exact identifier exists, but requested metadata could
    not be obtained or compared." Existence and incomplete comparison remain
    separately visible in the source records and field comparisons.
  The output also carries `coverage: "complete" | "partial" | "none"` and
  per-source outcomes, so a caller never has to reverse-engineer confidence from
  the verdict.
- **Cross-source disagreement is reported, never hidden.** Every returned record
  remains source-labelled, normalized identifiers are used to decide whether
  records describe the same work or related versions, and field conflicts are
  explicit. An exact identifier authority may establish which object an
  identifier denotes, but its metadata does not silently overwrite another
  source's incompatible title, author list, year, or venue.
- Per-source outcomes use the existing multi-source vocabulary:
  `ok`, `no_data`, `unavailable`, and `not_applicable`, with returned counts and
  an optional detail. Only `no_data` from every applicable source can contribute
  to `not_found`; `unavailable` contributes to `inconclusive`.
- `resolveMany` owns the high-volume policy needed by manuscript review. It
  deduplicates identical identifiers and normalized raw strings, coalesces
  in-flight duplicates, applies a bounded per-source concurrency/rate limiter,
  uses batch endpoints where their contract fits, and keeps a bounded in-memory
  metadata cache. Rate-limit responses respect `Retry-After` when present. A
  58-reference bibliography therefore does not become 58 simultaneous calls to
  each authority.
- The tool is rostered on the conversation agent and the literature reviewer,
  and added to the `SandboxToolName` union and resolver so a sandbox agent may
  declare it. All entry points share the same resolver configuration and pacing
  policy assembled at the composition root.

Deliberately out of scope, each for a stated reason:

- **Claim support** — whether the cited work actually supports the sentence
  citing it. It needs the abstract at minimum and often full text, which is a
  different cost profile and belongs behind an explicit opt-in. It is the error
  class `paper/RELATED-WORK.md` hit most often, so it is a follow-on, not a
  dismissal.
- **Enforcing the check in run synthesis.** The check is the easy half; the
  policy is not. Failing a whole synthesis on one unresolvable reference, versus
  annotating it, versus dropping the reference, is a decision about run
  semantics that deserves its own change. This one ships the resolver that
  change will need.
- **OpenAlex and dblp as search sources.** OpenAlex is the source of two of the
  four bad records in `paper/RELATED-WORK.md` §6. dblp would genuinely help for
  CS conference papers and can be added later without changing the verdict or
  coverage contracts. Registration-agency-neutral DOI lookup is not OpenAlex and
  does not reintroduce that record source.
- **A general reference parser.** The resolver normalizes identifiers, consumes
  caller-supplied structured fields when present, and derives only the bounded
  source queries it can justify. It does not claim to transform arbitrary
  bibliography prose into lossless CSL metadata.

## Capabilities

### New Capabilities

- `citation-resolution`: resolving one citation or a bounded batch against
  applicable bibliographic authorities and returning source-labelled records,
  field comparisons, coverage, and a five-value verdict. Covers input forms,
  agency-neutral DOI lookup, source applicability, disagreement, pacing and
  batching, and the rule that neither source failure nor absence alone proves a
  work is fabricated or unindexable.

### Modified Capabilities

- `harness-durable-runtime`: assemble one shared `CitationResolver` as a
  construction-time dependency and thread it to every agent/workflow surface
  that uses it, without ambient configuration or durability-engine coupling.
- `literature-search`: add citation resolution to the literature surface while
  preserving the existing search/details/full-text operations.
- `literature-reviewer`: add `resolve_citation` to the reviewer's exact tool
  inventory and teach it to distinguish search from verification.
- `per-agent-tool-allowlist`: add the resolver name to the closed
  `SandboxToolName` registry invariant.
- `integration-tests-external-api`: cover DOI content negotiation and Crossref
  matching with canonical records, a non-Crossref DOI, no-match, mismatch, and
  per-source failure fixtures.

## Impact

Harness source:

- `src/citations/types.ts`, `src/citations/resolve.ts` — public service input,
  output, comparison, verdict, coverage, and `resolveOne`/`resolveMany` contracts.
- `src/citations/clients/doi-registry.ts` — registration-agency-neutral handle
  existence, RA lookup, and metadata negotiation without assuming every RA
  supplies CSL.
- `src/citations/clients/crossref.ts` — Crossref exact/bibliographic client with
  injected polite-pool configuration.
- `src/literature/sources/` — shared arXiv, Semantic Scholar, and PubMed
  authority clients that own wire schemas, parsing, URL construction, injected
  transport, timeouts, and cancellation.
- `src/citations/clients/pubmed.ts`, `arxiv.ts`, `semantic-scholar.ts` — thin
  citation adapters over the shared authority clients; source applicability and
  citation-record mapping live here rather than in agent prose.
- `src/citations/rate-limit.ts` — shared bounded pacing, duplicate coalescing,
  cache, and `Retry-After` handling.
- `src/tools/research/resolve-citation.ts` — thin `defineTool` wrapper over the
  resolver service.
- `src/agents/conversation-agent.ts`, `src/tools/research/literature-reviewer.ts` —
  roster entries.
- `src/agents/sandbox/types.ts`, `src/agents/sandbox/shared.ts` — the
  `SandboxToolName` union and its resolver.
- `src/runtime/assemble.ts` and the sandbox-step dependency graph — construct
  and thread the shared resolver once.

No new package dependency and no image change. Resolution is host-side, as the
existing bio tools are, so the container's egress firewall is not in the path.

Network posture is explicit rather than inferred. A resolution call transmits
the supplied identifier, structured metadata, or raw citation string to the
applicable bibliographic authorities; it never transmits surrounding prose,
claims, results, or the rest of a document. A caller handling confidential
content decides whether to invoke external resolution at all. Manuscript review
therefore exposes an offline structural-reference mode and asks for approval
before it sends bibliography entries externally; it does not inherit a claim
that citation strings are somehow not document content.
