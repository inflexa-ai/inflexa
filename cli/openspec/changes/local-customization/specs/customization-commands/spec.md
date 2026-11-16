## Purpose

The customization commands give one surface for agents, skills, connectors, credentials and MCP servers. Each command is backed by an `/api/v1` route, so the TUI, a future GUI and the chat agent use the same operations.

## ADDED Requirements

### Requirement: Each customization command has a route

Each command of the groups `inflexa agent`, `inflexa skill`, `inflexa connector`, `inflexa credential` and `inflexa mcp` MUST call a route under `/api/v1` of the local server. The route MUST do the work, and the command MUST only print its result. The server MUST NOT need a restart after a change.

#### Scenario: A command and its route give the same result

- **WHEN** a client calls `GET /api/v1/agents` and the user runs `inflexa agent ls --json`
- **THEN** the two outputs list the same agents, drafts and gaps

### Requirement: The agent list shows built-in agents, custom agents and drafts

`GET /api/v1/agents` MUST list each built-in agent, each custom agent and each draft. Each item MUST give its id, its role, its kind (built-in or custom), `enabled`, its resolved attachments and its gaps. A built-in item MUST give its release defaults and the change of the user. A built-in item MUST NOT let a client change its prompt.

#### Scenario: A built-in agent shows the change of the user

- **GIVEN** a change that adds `lims` to `analyst`
- **WHEN** a client reads `GET /api/v1/agents/analyst`
- **THEN** the item gives the release defaults, the added `lims`, and the resolved attachments

#### Scenario: A prompt edit of a built-in agent is refused

- **WHEN** a client sends `PATCH /api/v1/agents/analyst` with a prompt
- **THEN** the server refuses the request, and the reason says that a built-in prompt is read-only

### Requirement: Each command declares its agent policy

Each new command MUST declare an agent policy: `auto` for a read, `approval` for a change, and `blocked` for `mcp add`, `mcp auth` and `mcp logout`. The reason of `mcp add` MUST say that the command makes the host run a command. The reason of `mcp auth` and `mcp logout` MUST say that they need a person at a browser.

#### Scenario: The chat agent cannot add an MCP server

- **WHEN** the chat agent calls `run_inflexa` with `mcp add`
- **THEN** the tool refuses the call with the reason of the policy

#### Scenario: The chat agent asks to attach a skill

- **WHEN** the chat agent calls `run_inflexa` with `agent attach analyst skill lab-protocols`
- **THEN** the tool asks the user for approval before the command runs

### Requirement: Adding a server warns about repeated calls

`inflexa mcp add` MUST print a warning that a recovery can call a tool of the server again. The warning MUST say that a tool with a side effect can then act two times.

#### Scenario: The warning on add

- **WHEN** the user adds a server
- **THEN** the output holds the warning before the confirmation
