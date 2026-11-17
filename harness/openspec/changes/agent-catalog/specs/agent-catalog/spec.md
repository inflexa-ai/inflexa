## Purpose

The agent catalog is the input through which a host gives the harness its agents, skills, connectors, MCP servers and credentials. It also defines the roles, the built-in agents, and the record that a workflow keeps of each agent.

## ADDED Requirements

### Requirement: The agent catalog is a required boot dependency

`bootHarness` MUST take an `AgentCatalog`. The catalog gives the agent entries, the `SkillStore`, the MCP server configs, the connector settings and the credentials. The harness MUST NOT read a path, a file or a database of the host to get agents, skills, MCP servers or credentials.

#### Scenario: A boot without a catalog does not typecheck

- **WHEN** an embedder calls `bootHarness` with no `catalog`
- **THEN** the typecheck refuses the call

#### Scenario: Two hosts give the same entries

- **GIVEN** a file-backed catalog and a database-backed catalog that give equal entries
- **WHEN** each catalog resolves
- **THEN** the two resolved agents are equal

### Requirement: Each agent has one role

Each agent MUST have exactly one role: `chat`, `planner`, `executor`, `profiler`, `synthesizer`, `analogy` or `reporter`. A custom agent can have each role. Each enabled executor is available to the plans. Each other role has one active agent at a time.

#### Scenario: The built-in agents and their roles

- **WHEN** the built-in agent definitions are listed
- **THEN** they are `inflexa` (`chat`), `planner` (`planner`), `analyst` and `drug-analyst` (`executor`), `data-profiler` (`profiler`), `synthesizer` (`synthesizer`), `analogy` (`analogy`) and `reporter` (`reporter`)

#### Scenario: A user changes the attachments of the planner

- **GIVEN** a `builtin` entry for `planner` that adds the MCP server `lims`
- **WHEN** the planner makes a plan
- **THEN** the planner can call the tools of `lims`

#### Scenario: A custom executor gets the role tools

- **GIVEN** a custom executor that attaches no connector, no MCP server and no skill
- **WHEN** its agent is built
- **THEN** its tools hold `execute_command`, `write_file`, `read_file` and `report_blocker`

#### Scenario: A custom agent of another role resolves

- **WHEN** a custom entry has the role `planner`
- **THEN** the entry is in the resolved agents, and it is not an executor

### Requirement: The host chooses the active agent of each role that one agent fills

`AgentCatalog.roles()` MUST give the agent that the host chose for each role that one agent fills, by id. The active agent of a role MUST be the chosen agent when it is enabled and has that role. Else it MUST be the built-in agent of the role, and a choice that does not resolve MUST give the gap `role_agent_unavailable`. A role whose active agent is off MUST have no active agent.

#### Scenario: A clone of the planner plans

- **GIVEN** a custom agent `lab-planner` with the role `planner`, and a choice of `lab-planner` for `planner`
- **WHEN** the planner makes a plan
- **THEN** the planner runs with the prompt and the attachments of `lab-planner`

#### Scenario: A chosen agent that is off

- **GIVEN** a choice of `lab-planner` for `planner`, and `lab-planner` is off
- **WHEN** the catalog resolves
- **THEN** the active planner is the built-in `planner`, and the gaps name `lab-planner`

### Requirement: Each built-in agent has a prompt body

Each built-in agent MUST have a prompt body. The harness MUST add the parts that each agent of the role shares around the body of the active agent, for example the identity, the skill index, and the list of the executors of the planner. A custom agent of a role MUST replace only the body.

#### Scenario: A custom planner keeps the list of the executors

- **GIVEN** an active custom planner whose body names no executor
- **WHEN** the planner makes a plan
- **THEN** its system prompt holds its body, then the enabled executors

### Requirement: The role gives the role tools

The role MUST give the role tools, and an agent definition MUST NOT name a role tool. Each role tool keeps the condition of its own capability. For example, `link_packages` exists only when the embedder binds the farm extension. The role tools of an executor are listed in the `harness-sandbox-agents` capability.

#### Scenario: The role tools of an executor

- **WHEN** a custom executor is built
- **THEN** it holds the workspace tools, the lease tools, `inspect_data_profile`, `report_blocker`, `list_available_packages` and the skill tools

### Requirement: An agent entry is a built-in agent or a custom agent

`AgentCatalog.agents()` MUST give a list of `AgentEntry` values. A `builtin` entry MUST name a `BuiltinAgentId` and MUST carry `enabled`, `add` and `remove`. It MUST NOT carry a prompt. A `custom` entry MUST carry `enabled` and a whole `CustomAgent`: `id`, `name`, `role`, `description`, `prompt`, `connectors`, `mcp` and `skills`.

A built-in agent with no entry MUST resolve to its release defaults. The attachments of a built-in agent MUST be its release defaults plus `add` minus `remove`.

#### Scenario: A built-in agent with no entry keeps its defaults

- **WHEN** the catalog gives no entry for `drug-analyst`
- **THEN** `drug-analyst` resolves with its release default connectors and skills

#### Scenario: A release default reaches a user who changed other attachments

- **GIVEN** a `builtin` entry for `analyst` that adds the MCP server `lab-lims`
- **AND** a release that adds a connector to the defaults of `analyst`
- **WHEN** the catalog resolves
- **THEN** `analyst` holds the new connector and `lab-lims`

#### Scenario: A removed default stays removed

- **GIVEN** a `builtin` entry for `analyst` whose `remove.connectors` names `pubmed`
- **WHEN** the catalog resolves
- **THEN** `analyst` does not hold the `pubmed` connector

### Requirement: Some built-in agents cannot be turned off

Only `drug-analyst`, `analogy` and each custom executor MUST obey `enabled: false`. Each other built-in agent MUST stay enabled. An entry that sets `enabled: false` for such an agent MUST give a gap.

#### Scenario: The analyst stays on

- **WHEN** a `builtin` entry sets `enabled: false` for `analyst`
- **THEN** `analyst` is in the resolved executors, and the gaps name the entry

#### Scenario: A disabled executor is absent

- **WHEN** a `builtin` entry sets `enabled: false` for `drug-analyst`
- **THEN** `drug-analyst` is absent from the resolved executors

#### Scenario: The analogy agent can be turned off

- **WHEN** a `builtin` entry sets `enabled: false` for `analogy`
- **THEN** the chat agent has no analogy report tool

#### Scenario: The planner stays on

- **WHEN** a `builtin` entry sets `enabled: false` for `planner`
- **THEN** the planner still makes plans, and the gaps name the entry

### Requirement: A reference that does not resolve is a gap, never an error

The resolution MUST check each attachment against the catalog: each connector against the connector registry, each MCP server against `mcpServers()`, and each skill against the `SkillStore`. A reference that does not resolve MUST become a gap that names the agent and the reference. The agent MUST resolve without that reference. A custom id that equals a built-in id or another custom id MUST become a gap, and that entry MUST be absent. A gap MUST NOT stop the boot, a plan or a run.

#### Scenario: An unknown skill is a gap

- **GIVEN** a custom executor that attaches the skill `lipidomics`, which the `SkillStore` does not list
- **WHEN** the catalog resolves
- **THEN** the executor resolves without `lipidomics`, and the gaps name the executor and `lipidomics`

#### Scenario: A custom agent cannot take a built-in id

- **WHEN** a custom entry has the id `analyst`
- **THEN** the gaps name the entry, and the built-in `analyst` is unchanged

### Requirement: The harness reads the catalog when it uses it

The harness MUST read the catalog when the planner makes a plan, when a run starts, and when a chat turn starts. It MUST NOT keep catalog state between these reads. Thus a change to the catalog applies at the next read, with no restart.

#### Scenario: A new executor reaches the next plan

- **GIVEN** a catalog that gains a custom executor after the boot
- **WHEN** the planner makes the next plan
- **THEN** the planner catalog lists the new executor

### Requirement: A workflow keeps the identity of each agent

When a workflow starts an agent, the harness MUST write the identity of the agent into the workflow input: `id`, `name`, `role`, `prompt` and `promptHash`. The identity MUST NOT hold the attachments, a credential or a server config. A recovery MUST use the prompt of the identity.

#### Scenario: An edit during a run does not change the prompt

- **GIVEN** a run that started with a custom executor
- **AND** the user edits the prompt of that executor during the run
- **WHEN** the run recovers after a crash
- **THEN** the step agent uses the prompt of the identity

#### Scenario: The identity holds no secret

- **WHEN** the workflow input of a run is read
- **THEN** it holds no credential value, no MCP header value and no MCP env value

### Requirement: A recovery uses the tools that are available

A recovery MUST resolve the tools of each agent from the catalog at the time of the recovery. A connector, an MCP server or a skill that is no longer available MUST be absent, and the recovery MUST continue. A recorded call of a tool that is no longer available MUST replay its recorded result. A new call of such a tool MUST return `unavailable`.

#### Scenario: An MCP server removed during a run

- **GIVEN** a step that called a tool of the MCP server `lims`, and the user removes `lims`
- **WHEN** the step recovers after a crash
- **THEN** the recorded call replays its recorded result, and the recovery completes

#### Scenario: A new call to a removed tool

- **GIVEN** a recovered step whose agent no longer has the `lims` server
- **WHEN** the model calls a tool of `lims` after the recovery
- **THEN** the call returns `unavailable`

#### Scenario: A connector added during a run

- **GIVEN** a run whose executor gets a new connector during the run
- **WHEN** a step recovers after a crash
- **THEN** the recovered step agent holds the new connector

### Requirement: A launch refuses a step whose agent is not available

A step whose agent is absent, disabled or unknown when the run starts MUST refuse the launch. The refusal MUST name the step and the agent. No step of the run MUST start.

#### Scenario: A removed executor refuses the launch

- **GIVEN** an approved plan whose step names `lipid-analyst`
- **AND** the catalog no longer holds `lipid-analyst`
- **WHEN** the run launches
- **THEN** the launch is refused, and the reason names the step and `lipid-analyst`

### Requirement: Each step records the identity of its agent

Each step MUST record the agent id, the agent name and the SHA-256 hash of the prompt of its identity. The step row and the `step_completed` provenance event MUST carry them.

#### Scenario: Two runs with one prompt record one hash

- **GIVEN** two runs whose steps use the same executor with the same prompt
- **WHEN** the step rows are read
- **THEN** the two rows hold the same prompt hash

#### Scenario: A prompt edit changes the hash

- **GIVEN** a custom executor whose prompt changes between two runs
- **WHEN** the step rows of the two runs are read
- **THEN** the prompt hashes differ
