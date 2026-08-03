## ADDED Requirements

### Requirement: Citation authorities have stubbed and opt-in live contract tests

The DOI Foundation, Crossref, PubMed, arXiv, and Semantic Scholar citation adapters SHALL have stubbed-fetch unit tests for success, no-data, malformed response, rate limit, timeout, and cancellation. The existing external-API integration suite SHALL cover canonical live resolution records and SHALL auto-skip when its network or key preconditions are absent. Citation-resolution integration tests SHALL run under the existing test command and SHALL NOT introduce a separate integration runner.

#### Scenario: Non-Crossref DOI is covered

- **WHEN** the live integration preconditions are available
- **THEN** the suite verifies a canonical DOI owned by a non-Crossref registration agency without treating Crossref absence as failure

#### Scenario: Offline test run remains green

- **WHEN** external integration preconditions are absent
- **THEN** live citation tests report skipped while all stubbed adapter and aggregation tests still run

#### Scenario: Upstream failure fixture preserves partial evidence

- **WHEN** a stubbed source fails while another returns a matching record
- **THEN** the test asserts the failed source is `unavailable`, the matching record is retained, and the aggregate is not `not_found`
