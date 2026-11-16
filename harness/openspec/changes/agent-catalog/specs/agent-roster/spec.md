## RENAMED Requirements

- FROM: `### Requirement: The sandbox-agent catalog is the single source of truth`
- TO: `### Requirement: The resolved agent catalog is the single source of truth`

## MODIFIED Requirements

### Requirement: The resolved agent catalog is the single source of truth

The executors of a plan, of a run and of an ad hoc step MUST come from the
resolution of the `AgentCatalog` (refer to the `agent-catalog` capability). The
harness MUST define the built-in agents in code, each with an id, a name, a
role, a description, a prompt and its default attachments. A built-in executor
can set `defaultMaxSteps`. The data profiler is a built-in agent of the role
`profiler`. It MUST NOT be an executor.

#### Scenario: The catalog holds the profiler and the two step agents

- **WHEN** the built-in sandbox agent definitions are inspected
- **THEN** they are exactly `data-profiler`, `analyst` and `drug-analyst`
- **AND** the executors among them are exactly `analyst` and `drug-analyst`

#### Scenario: AgentMeta carries a description and no capability list

- **WHEN** the type of a built-in executor definition is inspected
- **THEN** it has a `description` field and no `capabilities` or `suitableFor` field

#### Scenario: The data profiler is not an executor

- **WHEN** a catalog with no entries resolves
- **THEN** `data-profiler` has the role `profiler`, and the resolved executors do not hold it

### Requirement: The plannable catalog excludes non-plannable agents

The planner catalog MUST hold `{ id, description, liveSources }` for each enabled
executor of the resolved catalog, and no agent of another role. The plan step
`agent` field MUST accept only an id of the planner catalog. Thus the planner
can assign only an enabled executor.

#### Scenario: The plannable catalog holds the two step agents

- **WHEN** a catalog with no entries resolves
- **THEN** the planner catalog contains exactly the entries of `analyst` and `drug-analyst`

#### Scenario: Infrastructure agents are flagged non-plannable

- **WHEN** the planner catalog is built
- **THEN** `data-profiler` is in neither the planner catalog nor the accepted ids of the plan `agent` field

#### Scenario: Agents of other roles are not plannable

- **WHEN** the planner catalog is built
- **THEN** it holds none of `inflexa`, `reporter` and `data-profiler`

### Requirement: The plannable catalog names the live lookups of each agent

The `liveSources` of an executor MUST name the outside service of each connector
in its resolved attachments. The planner reads a live lookup as a database that
a step queries at run time, thus the step needs no staged copy of it. Each
connector MUST declare the name of its outside service. A connector that
queries no public database declares none.

#### Scenario: A database that no store stages is a live lookup

- **WHEN** the planner catalog lists the analyst and the drug analyst with their default connectors
- **THEN** the line of the analyst names `gnomAD`, `HumanBase tissue networks`, and `MyGene.info`
- **AND** the line of the drug analyst names `ChEMBL` and `FAERS`

#### Scenario: A tool that queries no public database adds no live lookup

- **WHEN** an executor attaches a connector that declares no outside service
- **THEN** that connector adds no name to the live lookups of the executor

#### Scenario: A removed connector removes its live lookup

- **GIVEN** a `builtin` entry for `analyst` that removes the `gnomad` connector
- **WHEN** the planner catalog lists the analyst
- **THEN** the line of the analyst does not name `gnomAD`

## REMOVED Requirements

### Requirement: Data-object-based routing

**Reason**: a user can add and remove executors, so a routing rule that names an agent goes stale. The planner routes each step by the description of each enabled executor.

**Migration**: the description of each built-in executor states its scope. The planner prompt drops its routing rules that name an agent.
