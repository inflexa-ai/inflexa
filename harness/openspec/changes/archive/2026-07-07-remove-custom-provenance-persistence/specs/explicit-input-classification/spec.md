# explicit-input-classification — delta

## MODIFIED Requirements

### Requirement: Prior-run classification is the one documented path-extraction fallback

The prior-run branch SHALL be the only place classification parses path segments,
and SHALL carry an in-code comment stating why the fallback exists: a read under
`runs/{otherRunId}/…` that matches neither the step's own run nor a `dependsOn`
entry carries no step metadata linking it, so the path segments are the only
available source for the `{source: "prior", runId, stepId}` classification. The
comment SHALL describe only code that exists — it SHALL NOT reference
declarations, types, or plumbing absent from the tree.

#### Scenario: Comment exists at the fallback location

- **WHEN** a developer reads the prior-run classification branch
- **THEN** they find a comment stating why path extraction is the only source for prior-run identity, with no references to nonexistent declarations
