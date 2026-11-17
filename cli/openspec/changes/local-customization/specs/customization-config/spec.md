## Purpose

The customization config holds the changes to the built-in agents, the MCP servers, the connector settings and the credential references in `config.json`. It never holds a secret value.

## ADDED Requirements

### Requirement: A built-in agent change holds only the difference

`config.json` MUST hold the change to a built-in agent as `agents.<id>: { enabled, add, remove }`. `add` and `remove` MUST each hold `connectors`, `mcp` and `skills` lists. The CLI MUST give each such block to the catalog as a `builtin` entry.

#### Scenario: A user adds a skill to the analyst

- **WHEN** the user runs `inflexa agent attach analyst skill lab-protocols`
- **THEN** `config.json` holds `agents.analyst.add.skills: ["lab-protocols"]`, and no other attachment of `analyst` is written

### Requirement: An MCP server entry describes how to reach the server

`config.json` MUST hold each MCP server as `mcp.<name>`. An entry MUST hold `type` (`stdio` or `http`), `approval` (`always` or `never`), `scriptable` and `enabled`. The default of `approval` MUST be `never`. A `stdio` entry MUST hold `command`, `args` and `env`. An `http` entry MUST hold `url` and `headers`, and can hold `auth: "oauth"`. A server name MUST obey `^[a-z0-9][a-z0-9-]{0,31}$`.

#### Scenario: A new server needs no approval

- **WHEN** the user adds a server with no `--approval` option
- **THEN** the entry holds `approval: "never"`

#### Scenario: A server name with a dot

- **WHEN** the user adds the server `lab.lims`
- **THEN** the CLI refuses it and gives the name rule

### Requirement: The config never holds a secret value

A credential MUST be declared as `credentials.<name>` with one of three sources: an environment variable, a helper command, or `stored`. An MCP `env` or `headers` value MUST name a credential as `${cred:<name>}` to carry a secret. A connector MUST name a credential for each slot. The CLI MUST resolve each reference when it builds the catalog. The CLI MUST NOT write a secret value into `config.json`.

#### Scenario: A header from a credential

- **GIVEN** `credentials.github: { kind: "env", var: "GITHUB_TOKEN" }` and an MCP header `Authorization: "Bearer ${cred:github}"`
- **WHEN** the CLI builds the catalog
- **THEN** the server config holds the value of `GITHUB_TOKEN` in the header, and `config.json` holds only the reference

#### Scenario: One credential serves two connectors

- **GIVEN** the connectors `pubmed` and `citations` that both name the credential `ncbi`
- **WHEN** each tool runs
- **THEN** each reads the value of the `ncbi` credential

### Requirement: The keys of harness.bioKeys are no longer read

The CLI MUST NOT read `harness.bioKeys`. Each key of an outside service MUST come from a credential that a connector names.

#### Scenario: An old config with bioKeys

- **GIVEN** a `config.json` that still holds `harness.bioKeys.drugbank`
- **WHEN** the server boots
- **THEN** the boot completes, and the DrugBank source is `unavailable` until the user declares a credential

### Requirement: The config holds the chosen agent of each role

`config.json` MUST hold the agent that the user chose for a role that one agent fills as `roles.<role>: <agent-id>`. A key that is no such role MUST be left out of the catalog.

#### Scenario: An unknown role key

- **GIVEN** `roles: { wizard: "x", planner: "lab-planner" }`
- **WHEN** the CLI builds the catalog
- **THEN** the catalog gives the choice of `planner` only

### Requirement: A connector setting has no on or off

`connectors.<id>` MUST hold only `endpoint` and `credentials`. Each agent chooses its connectors, thus a connector has no setting that turns it off for each agent.

#### Scenario: An old `enabled` key

- **GIVEN** `connectors.geo: { enabled: false }`
- **WHEN** the CLI reads the config
- **THEN** the setting of `geo` is empty, and each agent that attaches `geo` gets its tools

### Requirement: A stored credential keeps its value outside the config

The macOS Keychain, or a `0600` file under the data directory, MUST keep the value of a `stored` credential. A person types the value in the GUI or in a masked prompt of `inflexa credential set <name>`. No read gives the value back. `inflexa credential rm <name>` MUST remove the declaration and the value.

#### Scenario: A typed key

- **WHEN** the user runs `inflexa credential set lims-key` and types the key
- **THEN** `config.json` holds `credentials.lims-key: { kind: "stored" }`, and the Keychain holds the key

