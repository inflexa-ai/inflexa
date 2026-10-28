# Spec Delta

## ADDED Requirements

### Requirement: The loop repairs a tool name that a proxy alias left behind

When the model calls a tool that the request does not declare, and the name is one lowercase word, an underscore, and the id of a declared tool, the loop MUST run the call as a call of that declared tool, and it MUST log the alias. The loop MUST NOT change the name of a call of a declared tool. Each other unknown name MUST stay an unknown tool.

#### Scenario: An alias runs its tool

- **GIVEN** an agent that declares `search_gene`
- **WHEN** the model calls `art_search_gene`
- **THEN** the loop runs `search_gene`, and the recorded call names `search_gene`

#### Scenario: An unknown name stays unknown

- **WHEN** the model calls `art_write_file`, and no tool `write_file` is declared
- **THEN** the call stays a call of an unknown tool
