## ADDED Requirements

### Requirement: The literature reviewer can verify citations

The literature-reviewer agent's exact tool inventory SHALL include `resolve_citation`, backed by the runtime's shared resolver. Its prompt SHALL distinguish topical discovery from verification, SHALL preserve `inconclusive` and source coverage in its conclusions, and SHALL forbid presenting an outage or weak candidate as proof that a citation is fabricated.

#### Scenario: Reviewer verifies rather than searches by title alone

- **WHEN** the reviewer is asked whether a supplied citation exists and has correct metadata
- **THEN** it can call `resolve_citation` and reason from the returned field comparisons and coverage

#### Scenario: Reviewer retains uncertainty

- **WHEN** resolution returns `inconclusive` with an unavailable source
- **THEN** the reviewer reports the unresolved coverage gap
- **AND** it does not rewrite the verdict as `not_found`
