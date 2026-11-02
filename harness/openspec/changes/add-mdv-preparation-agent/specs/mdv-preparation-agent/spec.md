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

The `capabilities` of the agent MUST name the preparation, the curation, and the validation of an MDV asset. The `suitableFor` list MUST name the single-cell, scATAC-seq, multiome, spatial transcriptomics, and spatial proteomics data types, and the containers AnnData, MuData, and SpatialData.

#### Scenario: A request for MDV routes to the agent

- **GIVEN** a request to prepare a CosMx dataset for MDV
- **WHEN** the planner or the ad hoc router reads the catalog
- **THEN** the phrase `MDV asset preparation` of `mdv-preparation-agent` matches the request

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

### Requirement: The agent delivers an asset, not a project

The agent MUST deliver an MDV-ready AnnData, the context tables, a README, and the report of the validator. It MUST NOT need `mdvtools`, and it MUST NOT write the files of an MDV project.

#### Scenario: A step delivers the asset

- **WHEN** a step of the agent completes
- **THEN** the step output holds a `.mdv.h5ad` file, a `README.md`, and a validator report with zero errors
- **AND** the step output holds no `datasources.json`
