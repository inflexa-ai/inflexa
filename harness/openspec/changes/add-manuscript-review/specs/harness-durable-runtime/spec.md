## ADDED Requirements

### Requirement: The durable runtime registers the manuscript-review workflow

`assembleCoreRuntime` SHALL register `executeManuscriptReview` once at the host-neutral composition root and SHALL inject its pool, workspace confinement, artifact registry, chat provider, run authorizer, event stream, logger, and optional shared `CitationResolver` dependencies at construction time. `review_manuscript` SHALL authorize a reserved run and launch it only through `RunLauncher`; neither the tool nor workflow SHALL import the DBOS launch engine directly. The workflow SHALL derive sub-agent sessions from the authorized `RunSession` and SHALL NOT synthesize auth or billing envelopes.

#### Scenario: Review launches through existing seams

- **WHEN** `review_manuscript` reserves and authorizes a run
- **THEN** it launches `executeManuscriptReview` through `RunLauncher` with the same bare-UUID run id

#### Scenario: Workflow derives model-call identity

- **WHEN** a language or coherence phase invokes the configured chat provider
- **THEN** its agent session derives from the workflow's authorized `RunSession` with phase-specific provenance

#### Scenario: Resolver remains optional at construction

- **WHEN** the runtime has no citation resolver or the launch disables external resolution
- **THEN** the workflow remains capable of a complete offline structural reference review
