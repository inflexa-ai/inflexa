## ADDED Requirements

### Requirement: The composition root supplies the agent catalog

The composition root MUST build one `AgentCatalog` and give it to `bootHarness`. The catalog MUST read the agent files, the skill roots and `config.json` each time the harness reads the catalog. The composition root MUST NOT give `skillsDir`, `bioKeys` or `buildAgent` to the harness.

#### Scenario: A new agent file reaches the next plan

- **GIVEN** a running server
- **WHEN** the user adds a valid agent file and then asks for a plan
- **THEN** the planner catalog lists the new executor

#### Scenario: The catalog resolves credentials on each read

- **GIVEN** a connector whose credential is a helper command
- **WHEN** a tool of the connector runs two times
- **THEN** each run gets the value from `CredentialSource`, with its cache rules
