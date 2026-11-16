## Purpose

The customization config holds the changes to the built-in agents, the MCP servers, the connector settings and the credential references in `config.json`. It never holds a secret value.

## ADDED Requirements

### Requirement: A built-in agent change holds only the difference

`config.json` MUST hold the change to a built-in agent as `agents.<id>: { enabled, add, remove }`. `add` and `remove` MUST each hold `connectors`, `mcp` and `skills` lists. The CLI MUST give each such block to the catalog as a `builtin` entry.

#### Scenario: A user adds a skill to the analyst

- **WHEN** the user runs `inflexa agent attach analyst skill lab-protocols`
- **THEN** `config.json` holds `agents.analyst.add.skills: ["lab-protocols"]`, and no other attachment of `analyst` is written

### Requirement: An MCP server entry describes how to reach the server

`config.json` MUST hold each MCP server as `mcp.<name>`. An entry MUST hold `type` (`stdio` or `http`), `approval` (`always` or `never`), `scriptable` and `enabled`. A `stdio` entry MUST hold `command`, `args` and `env`. An `http` entry MUST hold `url` and `headers`, and can hold `auth: "oauth"`. A server name MUST obey `^[a-z0-9][a-z0-9-]{0,31}$`.

#### Scenario: A server name with a dot

- **WHEN** the user adds the server `lab.lims`
- **THEN** the CLI refuses it and gives the name rule

### Requirement: The config never holds a secret value

A credential MUST be declared as `credentials.<name>` with the `CredentialSource` schema of the model connection: an environment variable or a helper command. An MCP `env` or `headers` value MUST name a credential as `${cred:<name>}` to carry a secret. A connector MUST name a credential for each slot. The CLI MUST resolve each reference when it builds the catalog. The CLI MUST NOT write a secret value into `config.json`.

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
