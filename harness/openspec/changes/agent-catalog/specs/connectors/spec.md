## Purpose

A connector is a bundle of shipped tools that reach one outside service, with an optional endpoint and named credentials. A user attaches connectors to agents, never single tools.

## ADDED Requirements

### Requirement: Each connector has a category

Each connector of the registry MUST have a category, for example `literature` or `chemistry-and-drugs`. `describeConnectors()` MUST give the category, thus a host can group the connectors in a list for a person.

#### Scenario: The categories of two connectors

- **WHEN** a host lists the connectors
- **THEN** `pubmed` has the category `literature`, and `chembl` has the category `chemistry-and-drugs`

### Requirement: A connector bundles the shipped tools of an outside service

The harness MUST define each connector with `defineConnector`. A connector MUST have an `id`, a `description`, its tools, its credential slots and an optional default endpoint. The connector registry MUST be closed: a host MUST NOT define a connector. Each shipped tool that reaches an outside service MUST belong to exactly one connector.

#### Scenario: Each outside-service tool has a connector

- **WHEN** the tools of the harness that reach an outside service are compared with the connector registry
- **THEN** each such tool is in exactly one connector

#### Scenario: A host cannot add a connector

- **WHEN** a host gives settings for the connector id `my-service`, which the registry does not hold
- **THEN** the resolution reports a gap, and no tool is added

### Requirement: A user attaches connectors, never single tools

An agent MUST get each tool of each connector in its resolved `connectors` attachments. The catalog types MUST NOT let a host attach a single tool.

#### Scenario: A connector gives all its tools

- **GIVEN** a connector with two tools
- **WHEN** an executor attaches the connector
- **THEN** the executor holds both tools

### Requirement: The host gives the settings of each connector

For each connector, the host MUST be able to give `enabled`, an endpoint and the credential name of each slot. A connector with `enabled: false` MUST be absent for each agent. A connector with no settings MUST be enabled with its default endpoint and no credential.

#### Scenario: A disabled connector is absent everywhere

- **GIVEN** the `pubmed` connector with `enabled: false`
- **WHEN** the tools of `analyst`, of `inflexa` and of the planner are listed
- **THEN** no list holds `pubmed`

#### Scenario: An endpoint override

- **GIVEN** the settings of the `web-search` connector name an endpoint
- **WHEN** an agent calls `web_search`
- **THEN** the request goes to that endpoint

### Requirement: A tool reads its credential when its agent is built

The harness MUST read the value of a credential through `catalog.credential(name)` when it builds the agent of a turn or a step. Thus a new value reaches the next turn or step. The harness MUST NOT keep a credential value in a workflow input, a step output or a log. One credential name can serve more than one connector.

#### Scenario: One key serves two connectors

- **GIVEN** the `pubmed` and the `citations` connectors both name the credential `ncbi`
- **WHEN** each tool runs
- **THEN** each request carries the value that `catalog.credential("ncbi")` gives

#### Scenario: No key in the step output

- **WHEN** the step output of a keyed tool call is read
- **THEN** it holds no credential value

### Requirement: A missing key does not remove a tool

A tool whose required credential has no value MUST stay attached. Its call MUST return an error that names the connector and the credential. A missing optional credential MUST NOT cause an error. For a tool that queries many sources, a missing credential MUST mark only its source as `unavailable`.

#### Scenario: A required key is missing

- **GIVEN** the `comptox` connector with no value for its credential
- **WHEN** an agent calls the tool
- **THEN** the call returns an error that names `comptox` and its credential

#### Scenario: One source of a tool needs a key

- **GIVEN** the `drug-gene-interactions` connector with no DrugBank credential
- **WHEN** an agent calls the tool
- **THEN** DGIdb and PharmGKB answer, and DrugBank is `unavailable`

### Requirement: The built-in agents attach their tool sets of today as connectors

The default connectors of each built-in agent MUST give it the outside-service tools that it holds before this change. This rule includes the planner, the synthesizer, the analogy agent and the data profiler.

#### Scenario: The drug analyst keeps its lookups

- **WHEN** `drug-analyst` resolves with no entry
- **THEN** it holds `chembl`, `pubchem`, `opentargets`, `search_faers` and `search_clinical_trials`
