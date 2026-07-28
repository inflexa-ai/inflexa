## MODIFIED Requirements

### Requirement: Planner catalog derives from the sandbox-agent meta

`SANDBOX_AGENT_META` (`harness/src/agents/sandbox/index.ts`) SHALL be the source
of truth from which the planner catalog (`harness/src/agents/sandbox-catalog.ts`)
derives `PLANNABLE_AGENT_CATALOG` by projecting `{ id, capabilities, suitableFor }`
and filtering on `plannable !== false`. `generatePlan` SHALL consume the rendered
markdown via `formatAgentCatalog()`. Non-plannable agents (`data-profiler`,
`scientific-executor`, `adhoc-executor`) SHALL be excluded from the catalog.

#### Scenario: Planner catalog excludes non-plannable agents

- **WHEN** `formatAgentCatalog()` renders `PLANNABLE_AGENT_CATALOG`
- **THEN** it SHALL list each plannable agent with its `capabilities` and `suitableFor`
- **AND** `data-profiler`, `scientific-executor`, and `adhoc-executor` SHALL NOT appear

## ADDED Requirements

### Requirement: The adhoc executor is a writable, standards-bearing agent

The `adhoc-executor` agent SHALL be built with the default `createSandboxAgent`
options — it SHALL carry the `write_file`/`edit_file` pair and the appended
analysis-step standards — and SHALL NOT be built `readOnly`. Its deliverable
SHALL be its persisted files and `summary.md`, exactly as for a planned step
agent; the structural-honesty contract (a clean end-of-turn after writing is the
implicit success; inability is a terminal signal, not narrated stdout) SHALL
apply to it unchanged. No agent contract SHALL describe the adhoc executor as
unable to save files or as returning results only inline.

#### Scenario: Adhoc executor is built with write tools and standards

- **WHEN** the `adhoc-executor` agent is constructed
- **THEN** it contains `write_file` and `edit_file`, carries the analysis-step standards prompt, and is not built `readOnly`
