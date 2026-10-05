## MODIFIED Requirements

### Requirement: A record's namespace is bound at the seam, not typed into the message

A `Logger` MUST expose `named(name)`. It returns a logger that puts the
namespace in brackets before each later message. `named("boot")` renders
`info("harness booted")` as `[boot] harness booted`. Nested `named` calls MUST
compose with a dot separator (`[post-step.reconcile]`).

A module MUST bind its namespace through `named(...)`. It MUST NOT type a
`[module]` tag into each message string by hand. Thus the tag cannot change in
spelling or go missing, and a sink can recover the namespace without a parse of
the prose.

#### Scenario: A module binds its namespace once

- **GIVEN** a component that binds `logger.named("sandbox-reaper")`
- **WHEN** it logs `info("sweep completed", summary)`
- **THEN** the emitted message reads `[sandbox-reaper] sweep completed` and the summary rides as fields

#### Scenario: Nested namespaces compose with a dot

- **GIVEN** a logger derived through `named("post-step").named("reconcile")`
- **WHEN** it logs `warn("dropping phantom")`
- **THEN** the emitted message reads `[post-step.reconcile] dropping phantom`

#### Scenario: An unnamed logger leaves the message untouched

- **GIVEN** a `Logger` with no namespace bound
- **WHEN** it logs `info("bare")`
- **THEN** the emitted message is exactly `bare`
