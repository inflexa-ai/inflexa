## Purpose

Custom agents let a user add executors as Markdown files under `~/.config/inflexa/agents/`. The CLI reads each file, keeps a file that does not resolve as a draft, and converts agent files of other harnesses on import.

## ADDED Requirements

### Requirement: A custom agent is one Markdown file

The CLI MUST read each custom agent from `~/.config/inflexa/agents/<id>.md`. The file MUST hold YAML frontmatter and a prompt body. The frontmatter MUST hold `name` and `description`, and `name` MUST equal `<id>`. The frontmatter can hold `role`, `connectors`, `mcpServers` and `skills`. The default `role` is `executor`.

#### Scenario: A valid file becomes a custom entry

- **GIVEN** the file `agents/lipid-analyst.md` with `name: lipid-analyst`, a description, the connector `pubmed` and a prompt
- **WHEN** the CLI builds the catalog
- **THEN** the catalog holds a custom entry for `lipid-analyst` with that prompt and the connector `pubmed`

#### Scenario: An edit applies at the next read

- **GIVEN** a running server and the file of a custom agent
- **WHEN** the user edits the prompt in a text editor
- **THEN** the next plan uses the new prompt, with no restart

### Requirement: A file that does not resolve is a draft

The CLI MUST keep a file as a draft when one of these conditions is true:

- Its frontmatter does not parse.
- It has no `name` or no `description`.
- Its `name` does not equal its file name.
- Its id is a built-in id or the id of another file.
- It names an unknown connector, MCP server or skill.

A draft MUST NOT reach the harness. A draft MUST NOT stop the boot.

#### Scenario: A file with an unknown MCP server

- **GIVEN** an agent file whose `mcpServers` names `lipidmaps`, which `config.json` does not define
- **WHEN** the CLI builds the catalog
- **THEN** the agent is a draft whose gap names `lipidmaps`, and the catalog does not hold it

#### Scenario: A broken file does not stop the boot

- **GIVEN** an agent file whose frontmatter does not parse
- **WHEN** the server boots
- **THEN** the boot completes, and `inflexa agent ls` shows the file as a draft with the parse error

### Requirement: The model field is ignored

The CLI MUST ignore a `model` field in an agent file. The role models of the CLI MUST choose the model of each agent.

#### Scenario: A file with a model field

- **GIVEN** an agent file with `model: opus`
- **WHEN** the agent runs a step
- **THEN** the step uses the sandbox model of the config

### Requirement: Import converts a foreign agent file

`inflexa agent import <file>` MUST read a foreign agent file and write `agents/<id>.md`. The import MUST always write a file. It MUST keep `name`, `description` and the prompt, and it MUST drop `model` and the fields that Inflexa does not use. It MUST drop each foreign tool that an executor gets from its role. It MUST map each MCP tool reference to a server name, in each supported naming form.

#### Scenario: Import from Claude Code

- **GIVEN** a Claude Code agent file with `tools: Read, Bash, mcp__github__search_code` and `model: sonnet`
- **WHEN** the user imports it
- **THEN** the new file has `mcpServers: [github]` and no `model`, and it lists neither `Read` nor `Bash`

#### Scenario: An unknown tool makes a draft

- **GIVEN** a foreign agent file whose `tools` names `NotebookEdit`
- **WHEN** the user imports it
- **THEN** the new file lists `NotebookEdit` under `tools`, and the agent is a draft whose gap names `NotebookEdit`

#### Scenario: Each MCP naming form maps to a server

- **WHEN** an imported file names `mcp__lims__query`, `lims/query`, `mcp_lims_*` or `lims_query` with a server `lims` in `config.json`
- **THEN** the new file lists `lims` under `mcpServers`

### Requirement: Clone copies a built-in executor

`inflexa agent clone <id> <new-id>` MUST write `agents/<new-id>.md` with the prompt, the description and the resolved attachments of the built-in executor `<id>`. The clone MUST have no link to the built-in agent. A user MUST be able to clone only an executor.

#### Scenario: A clone keeps the attachments

- **GIVEN** a `builtin` change that adds the MCP server `lims` to `analyst`
- **WHEN** the user clones `analyst` to `my-analyst`
- **THEN** `agents/my-analyst.md` holds the prompt of `analyst`, its connectors, its skills and `lims`

#### Scenario: A release does not change a clone

- **GIVEN** a clone of `analyst`
- **WHEN** a release changes the prompt of `analyst`
- **THEN** the file of the clone is unchanged
