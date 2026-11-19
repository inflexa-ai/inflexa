## Purpose

The customization commands give one surface for agents, skills, connectors, credentials and MCP servers. Each command is backed by an `/api/v1` route, so the TUI, a future GUI and the chat agent use the same operations.

## ADDED Requirements

### Requirement: Each customization command has a route

Each command of the groups `inflexa agent`, `inflexa skill`, `inflexa connector`, `inflexa credential` and `inflexa mcp` MUST call a route under `/api/v1` of the local server. The route MUST do the work, and the command MUST only print its result. The server MUST NOT need a restart after a change.

#### Scenario: A command and its route give the same result

- **WHEN** a client calls `GET /api/v1/catalog/agents` and the user runs `inflexa agent ls --json`
- **THEN** the two outputs list the same agents, drafts and gaps

### Requirement: The agent list shows built-in agents, custom agents and drafts

`GET /api/v1/catalog/agents` MUST list each built-in agent, each custom agent and each draft, and each role that one agent fills with its active agent. Each item MUST give its id, its role, its kind (built-in or custom), `enabled`, `active`, its resolved attachments and its gaps. A built-in item MUST give its release defaults and the change of the user. A built-in item MUST NOT let a client change its prompt.

#### Scenario: A built-in agent shows the change of the user

- **GIVEN** a change that adds `lims` to `analyst`
- **WHEN** a client reads `GET /api/v1/catalog/agents/analyst`
- **THEN** the item gives the release defaults, the added `lims`, and the resolved attachments

#### Scenario: A prompt edit of a built-in agent is refused

- **WHEN** a client sends `PATCH /api/v1/catalog/agents/analyst` with a prompt
- **THEN** the server refuses the request, and the reason says that a built-in prompt is read-only

### Requirement: Each command declares its agent policy

Each new command MUST declare an agent policy by its risk, not by read or write. A read and a change to the state of Inflexa MUST run with no prompt. A command that makes the host run a command, or that sends a secret to a new place, MUST ask, and its approval MUST cover only the exact command. A command that deletes the work of the user MUST ask. `mcp auth` and `mcp logout` MUST stay blocked, and their reason MUST say that they need a person at a browser.

#### Scenario: The chat agent asks to add an MCP server

- **WHEN** the chat agent calls `run_inflexa` with `mcp add`
- **THEN** the tool asks the user, and an "always" covers only that exact command

#### Scenario: A credential from a helper command asks

- **WHEN** the chat agent calls `run_inflexa` with `credential set <name> --command <command>`
- **THEN** the tool asks the user, and `credential set <name> --env <var>` runs with no prompt

#### Scenario: An agent that no person answers refuses a server that asks approval

- **GIVEN** the server `lims` with `approval: "always"`
- **WHEN** the user runs `inflexa agent attach analyst mcp lims`
- **THEN** the CLI refuses the attach and says that only the chat agent and the reporter can attach the server

#### Scenario: The chat agent attaches a skill

- **WHEN** the chat agent calls `run_inflexa` with `agent attach analyst skill lab-protocols`
- **THEN** the command runs with no prompt

#### Scenario: A credential for a connector slot asks

- **WHEN** the chat agent calls `run_inflexa` with `connector set pubmed --credential api_key=github-token`
- **THEN** the tool asks the user for that exact command, because the connector sends the credential to its endpoint

### Requirement: A chat names its own analysis with no prompt, and changes no other analysis

`--analysis` with the id or the name of the analysis of the chat MUST NOT make a call ask. `store add` and `store link` with a different analysis MUST be blocked, because a chat has no reason to change the package set of a different analysis.

#### Scenario: The chat names its own analysis

- **WHEN** the chat agent calls `run_inflexa` with `store link lipidr --analysis <the id of its analysis>`
- **THEN** the command runs with no prompt, and the same call with a different analysis is blocked

### Requirement: An import from the chat asks for a folder of the host

`skill import` and `agent import` MUST run from the chat with no approval prompt only while each path is relative. An absolute path, a home path, or a path with `..` MUST ask for the exact command. `--replace` MUST NOT ask, because the CLI keeps the replaced version.

#### Scenario: The chat imports a folder of a different app

- **WHEN** the chat runs `inflexa skill import /home/u/.claude/skills/x`
- **THEN** the user approves the exact command before it runs

### Requirement: The MCP list shows a failed start

`inflexa mcp ls` and `GET /api/v1/mcp` MUST give the last failed start of each server, with its time and its reason, as the runtime of the local server reports it.

#### Scenario: A server that ends at start

- **GIVEN** an attached server whose process ended before it answered in the last turn
- **WHEN** the user runs `inflexa mcp ls`
- **THEN** the line of the server shows the time and the reason of the failure

### Requirement: A command that acts on one item at a time takes many items

`agent attach`, `agent detach`, `agent enable`, `agent disable`, `agent import`, `agent rm`, `skill import`, `credential rm`, `mcp enable`, `mcp disable` and `mcp rm` MUST take one or more values. The command MUST apply the values in order and stop at the first failure. A command of the policy `approval` MUST ask one time for all its values.

#### Scenario: The chat agent detaches many skills in one call

- **WHEN** the chat agent runs `inflexa agent detach analyst skill single-cell spatial-omics proteomics`
- **THEN** one `run_inflexa` call detaches the three skills with no prompt

### Requirement: Adding a server warns about repeated calls

`inflexa mcp add` MUST print a warning that a recovery can call a tool of the server again. The warning MUST say that a tool with a side effect can then act two times.

#### Scenario: The warning on add

- **WHEN** the user adds a server
- **THEN** the output holds the warning before the confirmation

### Requirement: The user imports an MCP server of another harness

`inflexa mcp find` and `GET /api/v1/mcp/found` MUST list the MCP servers in the configs of Claude Code, Claude Desktop, Cursor, Windsurf and VS Code on the machine. The list MUST give the keys of `env` and `headers`, never their values. `inflexa mcp import` and `POST /api/v1/mcp/import` MUST copy one server, store each value of its `env` and `headers` as a stored credential, and put a `${cred:<name>}` reference in its place.

#### Scenario: Import keeps the values out of the config

- **GIVEN** a Claude Code server `lims` with `env: { LIMS_TOKEN: "s" }`
- **WHEN** the user imports it
- **THEN** the entry holds `LIMS_TOKEN: "${cred:lims-lims-token}"`, and the store holds `s`

### Requirement: The user installs an MCP server of the MCP Registry

`inflexa mcp search` and `GET /api/v1/mcp/registry` MUST search the official MCP Registry through the server. `inflexa mcp install` and `POST /api/v1/mcp/install` MUST build the entry of one install option: an npm, PyPI or OCI package that a local command runs, or a remote with the streamable HTTP transport. A secret input MUST go to a stored credential, and each other input MUST go into the entry.

#### Scenario: Install from the registry

- **GIVEN** a registry server with an npm package and a secret variable
- **WHEN** the user installs it with the value of the variable
- **THEN** the entry runs `npx -y <package>@<version>`, and the variable references a stored credential

### Requirement: The terminal shows the customizations, and edits only the connectors and the credentials

The palette of the terminal UI MUST have a Customize group with the commands Agents, Skills, MCP servers, Connectors and Credentials. Agents, Skills and MCP servers MUST be read-only. Agents MUST group the agents by role and mark each agent as active, off, not chosen or draft. Skills MUST group the skills into Custom and Built-in, the newest custom skill first, and MUST name the active agents that use each skill. A skill MUST open the list of its files, and a file MUST open its text. Connectors MUST edit the endpoint and the credential of each slot. Credentials MUST add, change and remove a credential that reads an environment variable or a command. The terminal MUST NOT take a stored value, because its dialog does not hide the text.

#### Scenario: The user sees a skill that the chat added

- **GIVEN** a chat that imported `lipidomics-lcms`
- **WHEN** the user opens Customize, Skills
- **THEN** `lipidomics-lcms` is the first row, and its files open as text
