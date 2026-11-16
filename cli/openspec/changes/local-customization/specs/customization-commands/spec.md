## Purpose

The customization commands give one surface for agents, skills, connectors, credentials and MCP servers. Each command is backed by an `/api/v1` route, so the TUI, a future GUI and the chat agent use the same operations.

## ADDED Requirements

### Requirement: Each customization command has a route

Each command of the groups `inflexa agent`, `inflexa skill`, `inflexa connector`, `inflexa credential` and `inflexa mcp` MUST call a route under `/api/v1` of the local server. The route MUST do the work, and the command MUST only print its result. The server MUST NOT need a restart after a change.

#### Scenario: A command and its route give the same result

- **WHEN** a client calls `GET /api/v1/catalog/agents` and the user runs `inflexa agent ls --json`
- **THEN** the two outputs list the same agents, drafts and gaps

### Requirement: The agent list shows built-in agents, custom agents and drafts

`GET /api/v1/catalog/agents` MUST list each built-in agent, each custom agent and each draft. Each item MUST give its id, its role, its kind (built-in or custom), `enabled`, its resolved attachments and its gaps. A built-in item MUST give its release defaults and the change of the user. A built-in item MUST NOT let a client change its prompt.

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

### Requirement: Adding a server warns about repeated calls

`inflexa mcp add` MUST print a warning that a recovery can call a tool of the server again. The warning MUST say that a tool with a side effect can then act two times.

#### Scenario: The warning on add

- **WHEN** the user adds a server
- **THEN** the output holds the warning before the confirmation
