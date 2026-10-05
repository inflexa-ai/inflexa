## ADDED Requirements

### Requirement: Citation verification is distinct from literature discovery

The literature surface SHALL expose a `resolve_citation` tool backed by the shared `CitationResolver`. The tool SHALL accept one evidence-preserving citation input and SHALL return structured source outcomes, records, field comparisons, coverage, conflicts, and verdict without flattening them into an unsupported binary existence claim. Existing search, article-detail, and full-text tool contracts SHALL remain unchanged.

#### Scenario: Conversation agent verifies a supplied citation

- **WHEN** the conversation agent calls `resolve_citation` with a user-supplied reference
- **THEN** the tool returns the shared resolver's structured result for that reference
- **AND** the result distinguishes `not_found` from `inconclusive`

#### Scenario: Search behavior is unchanged

- **WHEN** an agent needs papers about a topic rather than verification of one supplied reference
- **THEN** the existing literature-search tools remain available with their existing inputs and outputs

### Requirement: Literature consumers share one wire client per authority

The harness SHALL implement arXiv, Semantic Scholar, and PubMed endpoint
construction, wire validation/parsing, injected HTTP transport, timeout
handling, and caller cancellation once per authority in a source client that is
independent of agent tools and citation-resolution policy. Existing discovery
tools and citation adapters SHALL delegate those operations to the shared source
client while retaining their distinct public contracts. Neither consumer SHALL
import the other.

#### Scenario: An authority response contract changes

- **WHEN** an arXiv, Semantic Scholar, or PubMed wire schema or parser is updated
- **THEN** the change is made in that authority's shared source client
- **AND** both discovery and citation verification consume the same updated interpretation

#### Scenario: Discovery and verification expose different contracts

- **WHEN** an agent searches for papers and a workflow verifies a supplied citation
- **THEN** the discovery tool retains its existing input and output envelope
- **AND** the citation adapter retains source applicability, evidence status, and citation-record mapping
- **AND** both operations use the same authority transport and parser without invoking each other
