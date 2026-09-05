## ADDED Requirements

### Requirement: The knowledge plane is configured by an endpoint and an environment key

The user config MUST carry an optional top-level `knowledge` block with one field, `baseUrl`. The key MUST come from the `INFLEXA_KNOWLEDGE_API_KEY` variable and from nothing else. The CLI MUST NOT persist the key, log it, or send it to provenance. An absent block MUST resolve to no client, which is the default state of the open-source CLI.

#### Scenario: No block

- **GIVEN** a config without the `knowledge` block
- **WHEN** the runtime boots
- **THEN** the harness receives no knowledge client, and every agent runs as before

#### Scenario: An endpoint and a key

- **GIVEN** a config with `knowledge.baseUrl` and the variable set in the environment
- **WHEN** the runtime boots
- **THEN** the boot builds one HTTP client and binds it to the planner, to the step agents, and to the conversation agent through `hostTools`

#### Scenario: An endpoint without a key

- **GIVEN** a config with `knowledge.baseUrl` and no variable in the environment
- **WHEN** the runtime boots
- **THEN** the boot logs a warning that names the variable, binds no client, and continues

#### Scenario: A malformed block

- **GIVEN** a config whose `knowledge.baseUrl` is not a string
- **WHEN** the config is read
- **THEN** the block degrades to unset, the other keys stay intact, and no client binds
