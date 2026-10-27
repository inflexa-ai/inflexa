# Spec Delta

## MODIFIED Requirements

### Requirement: The commands of the local server process are blocked or gated for the agent

The conversation of the agent runs inside the local server, thus a command that starts or stops that server acts on the process of the agent itself. `inflexa serve` and `inflexa server stop` MUST be registered `blocked`, and the tool MUST refuse each one outright: a blocked result to the model, WITHOUT prompting for approval and WITHOUT spawning. The reason of `server stop` MUST tell the model that the stop ends its own turn, and that the user runs it from their own shell. `inflexa server status` MUST be `auto`, with `json` as its one safe flag, because it reads the discovery file, probes the server, and writes nothing. `inflexa server logs` MUST be `approval`. `inflexa server walk` MUST be `blocked`. Its reason MUST tell the model that only the local server starts it, and that it streams a binary protocol on stdout. The introspection of each (`--help`) MUST remain allowed.

#### Scenario: inflexa server stop is refused

- **WHEN** the tool is invoked with `["server", "stop"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: inflexa serve is refused

- **WHEN** the tool is invoked with `["serve", "--detach"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning

#### Scenario: The server status runs free

- **WHEN** the tool is invoked with `["server", "status", "--json"]`
- **THEN** it spawns without prompting and returns the captured output

#### Scenario: inflexa server walk is refused

- **WHEN** the tool is invoked with `["server", "walk", "/"]`
- **THEN** it returns a blocked result to the model without prompting and without spawning
