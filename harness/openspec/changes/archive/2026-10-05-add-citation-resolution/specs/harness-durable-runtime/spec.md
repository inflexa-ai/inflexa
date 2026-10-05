## ADDED Requirements

### Requirement: The runtime assembles one shared CitationResolver

`assembleCoreRuntime` SHALL construct one host-agnostic `CitationResolver` from injected configuration and source clients and SHALL thread that same service to every tool and workflow surface that uses citation resolution. Resolver source enablement, timeouts, pacing, cache bounds, and optional Crossref contact identity SHALL be construction-time dependencies and SHALL NOT be read from ambient environment variables. A durable workflow SHALL call the service inside its own named durable step and SHALL NOT construct a `ToolContext` to invoke the agent-facing tool.

#### Scenario: Agent surfaces share pacing state

- **WHEN** the conversation agent and literature reviewer resolve citations in the same runtime
- **THEN** both tool instances close over the same resolver service and per-source limiter state

#### Scenario: Workflow uses the service boundary

- **WHEN** a deterministic workflow performs a citation-resolution batch
- **THEN** it invokes `CitationResolver.resolveMany` inside a named durable step
- **AND** it does not call `resolve_citation` or synthesize a tool session

#### Scenario: Crossref identity is injected

- **WHEN** an embedder supplies no Crossref contact identity
- **THEN** the resolver uses public Crossref access without reading an environment variable or hardcoded maintainer address
