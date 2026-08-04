## ADDED Requirements

### Requirement: Durable model calls run through one shared named-step wrapper

A durable workflow SHALL make its model calls through the shared durable
LLM-step wrapper rather than a per-workflow copy. The wrapper SHALL own the
per-call `DBOS.runStep` cache slot under a caller-supplied, attempt-numbered
step name; the forced-tool structured-output pattern for schema-validated
results; and the billing-gateway 402 handling that self-sends a budget marker
and returns a sentinel so the workflow's own finalisation writes
`suspended_insufficient_funds` and materialises the resumable cancelled state.
Because the step name is supplied by the caller, relocating the wrapper SHALL
NOT change any existing durable step identity.

#### Scenario: Two workflows share one wrapper

- **WHEN** a target-assessment phase and a manuscript-review phase each make a structured model call
- **THEN** both run through the same wrapper with their own attempt-numbered step names
- **AND** neither workflow contains its own copy of the 402 marker-and-suspend choreography

#### Scenario: Relocation preserves step identity

- **WHEN** the wrapper moves to the shared workflow library
- **THEN** every existing call site's durable step name is unchanged
- **AND** an in-flight workflow replays against the same cache slots
