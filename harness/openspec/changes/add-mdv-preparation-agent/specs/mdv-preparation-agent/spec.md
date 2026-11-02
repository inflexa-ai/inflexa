## ADDED Requirements

### Requirement: Agent definition and composition

The system MUST define the agent in `agents/sandbox/mdv-preparation-agent.ts`. It MUST construct the agent with `createSandboxAgent(deps, meta, mdvPreparationAgentPrompt)`. The `AgentDefinition` MUST carry `id: "mdv-preparation-agent"`. The agent MUST be plannable.

#### Scenario: The factory gives a valid agent

- **WHEN** `createSandboxAgents(deps)` runs
- **THEN** it holds an entry `mdv-preparation-agent`
- **AND** that entry resolves each name in `meta.tools`, the workspace tools, and the skill tools

#### Scenario: The planner can assign the agent

- **WHEN** `PLANNABLE_AGENT_CATALOG` is inspected
- **THEN** it holds `mdv-preparation-agent` with its capabilities and its `suitableFor` list

### Requirement: The capabilities name the MDV task

The `capabilities` of the agent MUST name the preparation, the conversion, the curation, the views, and the validation of an MDV project. The `suitableFor` list MUST name the single-cell, scATAC-seq, multiome, spatial transcriptomics, and spatial proteomics data types, and the containers AnnData, MuData, and SpatialData.

#### Scenario: A request for an MDV project routes to the agent

- **GIVEN** a request to prepare a CosMx dataset for MDV
- **WHEN** the planner or the ad hoc router reads the catalog
- **THEN** the phrase `MDV project preparation` of `mdv-preparation-agent` matches the request

### Requirement: The agent declares the MDV pack and the modality packs

`meta.skills` MUST be `mdv-preparation`, `single-cell`, `spatial-omics`, `chromatin-regulation`, and `shared/omics-general`. The prompt MUST name the same packs in its "Your skills" line.

#### Scenario: The skills resolve at boot

- **WHEN** `validateAgentSkills` runs with the repository `skills/` tree
- **THEN** each declared pack of the agent has a readable `SKILL.md`

### Requirement: The agent uses the base tools only

`meta.tools` MUST be `BASE_SANDBOX_TOOLS`. The agent needs no literature or bio lookup tool, because the task changes the form of data that the user gives.

#### Scenario: The tool list is the base list

- **WHEN** the meta of the agent is inspected
- **THEN** `meta.tools` equals `BASE_SANDBOX_TOOLS`

### Requirement: The agent stops cleanly when mdvtools is absent

If the sandbox does not hold `mdvtools`, the agent MUST deliver the curated AnnData, report that the conversion needs `mdvtools`, and stop. It MUST NOT write the files of an MDV project by hand.

#### Scenario: The package store does not hold mdvtools

- **GIVEN** a step whose sandbox has no `mdvtools`
- **WHEN** the agent reaches the conversion
- **THEN** the step output holds the curated `.h5ad`
- **AND** the summary names the absent package
- **AND** the step output holds no `datasources.json`
