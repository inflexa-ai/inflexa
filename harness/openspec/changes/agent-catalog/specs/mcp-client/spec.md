## Purpose

The MCP client lets each agent call the tools of the MCP servers that it attaches. The calls run in the harness process on the host, never in the sandbox.

## ADDED Requirements

### Requirement: MCP calls run in the harness process on the host

The harness MUST call each MCP server from its own process. A call MUST run as one durable step of the loop. The sandbox MUST NOT reach an MCP server. The harness MUST accept a `stdio` server and a Streamable HTTP server, and each MCP protocol version that the SDK supports.

#### Scenario: An executor calls an MCP tool

- **GIVEN** an executor that attaches the MCP server `lab-lims`
- **WHEN** the executor calls a tool of `lab-lims` during a step
- **THEN** the harness process sends the call, and the sandbox sends no request to the server

#### Scenario: A recovered step returns the recorded result

- **GIVEN** a step whose MCP call completed and was recorded
- **WHEN** the step replays after a crash
- **THEN** the replay returns the recorded result and sends no request to the server

### Requirement: Only an agent that attaches a server gets its tools

An agent MUST get the tools of an MCP server only when the server is in its resolved `mcp` attachments. An agent of each role can attach an MCP server.

#### Scenario: A server attached to the chat agent only

- **GIVEN** an MCP server that only `inflexa` attaches
- **WHEN** the tools of `analyst` are listed
- **THEN** no tool of that server is in the list

### Requirement: MCP tool names are unique and fit each provider

The name of an MCP tool MUST be `mcp__<server>__<tool>`. Each character outside `[a-zA-Z0-9_-]` MUST become `_`. A name longer than 64 characters MUST be cut and MUST end with a short hash of the full name. Two tools that give one name MUST each get a hash suffix.

#### Scenario: A dot in a tool name

- **WHEN** the server `github` gives the tool `repos.search`
- **THEN** the agent sees the tool `mcp__github__repos_search`

#### Scenario: A long name fits the limit

- **WHEN** a server gives a tool whose prefixed name has 90 characters
- **THEN** the agent sees a name of at most 64 characters that ends with a hash

### Requirement: Approval is a setting of the server

With `approval: "always"`, each call to a tool of the server MUST go through the tool-approval gate. With `approval: "never"`, no call MUST ask. The harness MUST NOT use the annotations of a server, for example `readOnlyHint`, to decide approval.

#### Scenario: A server that needs approval

- **GIVEN** a server with `approval: "always"`
- **WHEN** an agent calls one of its tools
- **THEN** the call waits for the decision of the user before the request is sent

#### Scenario: An annotation does not skip approval

- **GIVEN** a server with `approval: "always"` whose tool says `readOnlyHint: true`
- **WHEN** an agent calls that tool
- **THEN** the call still goes through the approval gate

### Requirement: A server that asks approval needs an agent that a person answers

Only an agent of the role `chat` or `reporter` runs in a chat turn, where a person answers an approval. An agent of each other role MUST NOT get the tools of a server with `approval: "always"`. The catalog MUST give a gap for that attachment, and the agent MUST resolve without the server.

#### Scenario: An executor does not get a server that asks approval

- **GIVEN** a server with `approval: "always"` that an executor attaches
- **WHEN** the catalog resolves
- **THEN** the executor resolves without the server, and the catalog gives the gap `approval_needs_a_person`

### Requirement: An MCP tool is a direct tool unless the server is scriptable

An MCP tool MUST be a direct tool of the agent. With `scriptable: true`, the tool MUST also be a script tool of `run_script`. A server with `approval: "always"` MUST NOT be scriptable. Such a config MUST give a gap, and its tools MUST stay direct only.

#### Scenario: A scriptable server

- **GIVEN** a server with `scriptable: true` and `approval: "never"`
- **WHEN** an agent writes a script that calls a tool of the server
- **THEN** `run_script` runs the call

#### Scenario: A scriptable server that needs approval

- **WHEN** a server config has `scriptable: true` and `approval: "always"`
- **THEN** the resolution reports a gap, and `run_script` does not get the tools of the server

### Requirement: An MCP result becomes a tool output

The text blocks of a result MUST become the text of the tool output. `structuredContent` MUST become JSON. An image block or a resource block MUST become one line that names its type and its URI. A result with `isError: true` MUST become a tool error. The output cap of the loop MUST apply to each MCP output.

#### Scenario: A large result is cut

- **WHEN** an MCP tool returns a text larger than the output cap of the loop
- **THEN** the agent gets an excerpt, and `read_tool_output` reads the rest

#### Scenario: An error result

- **WHEN** an MCP tool returns `isError: true`
- **THEN** the agent gets a tool error with the text of the result

### Requirement: A server that does not answer removes only its tools

When the harness builds an agent and a server does not answer, the tools of that server MUST be absent. The harness MUST log a warning that names the server and the reason. The reason MUST hold the last error output of a local server. The agent MUST run with its other tools.

#### Scenario: A stopped server

- **GIVEN** an executor that attaches two MCP servers, and one server does not start
- **WHEN** the step agent is built
- **THEN** the agent holds the tools of the other server, and the log names the server that did not start

### Requirement: A failed start reaches the agent and the host

The system prompt of the chat agent and of the reporter MUST name each attached server that did not start, with the reason. The runtime MUST give the last start failure of each server to the host, and a later start MUST clear it.

#### Scenario: The chat agent learns why a server is absent

- **GIVEN** a chat agent that attaches a local server whose process ends before it answers
- **WHEN** a turn starts
- **THEN** the system prompt names the server with the reason, and the host lists the failure for the server

### Requirement: The host owns the MCP sign-in

The harness MUST take the `OAuthClientProvider` of an HTTP server from its config. The harness MUST NOT store a token. If a call gets an expired token that cannot refresh, the call MUST return a tool error that tells the user to sign in again.

#### Scenario: An expired sign-in

- **GIVEN** an HTTP server whose refresh token is rejected
- **WHEN** an agent calls one of its tools
- **THEN** the agent gets a tool error that names the server and asks for a new sign-in

### Requirement: The harness keeps one connection for each server

The harness MUST connect to a server at its first use and keep the connection for the process. It MUST connect again when the config of the server changes. It MUST close each connection at shutdown.

#### Scenario: A config change

- **GIVEN** a connected `stdio` server
- **WHEN** the catalog gives a different command for that server
- **THEN** the harness stops the old process and starts the new one at the next use
