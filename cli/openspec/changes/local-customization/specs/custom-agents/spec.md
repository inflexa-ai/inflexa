## Purpose

Custom agents let a user add an agent of each role as Markdown files under `~/.config/inflexa/agents/`. The CLI reads each file, keeps a file that does not resolve as a draft, and converts agent files of other harnesses on import.

## ADDED Requirements

### Requirement: A custom agent is one Markdown file

The CLI MUST read each custom agent from `~/.config/inflexa/agents/<id>.md`. The file MUST hold YAML frontmatter and a prompt body. The frontmatter MUST hold `name` and `description`, and `name` MUST equal `<id>`. The frontmatter can hold `role`, `connectors`, `mcpServers` and `skills`. `role` can name each role of the harness, and the default `role` is `executor`.

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
- Its `role` names no role of the harness.
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

### Requirement: Import gives the role that the user chooses

An imported agent MUST get the role that the user chooses with `--role`. With no choice, it MUST get the role `executor`.

#### Scenario: The user chooses the role

- **WHEN** the user imports a foreign agent file with `--role reporter`
- **THEN** the new file has the role `reporter`, and an unknown role is refused with the list of the roles

### Requirement: Find lists the agent files of other harnesses

`inflexa agent find` MUST list the Markdown agent files in the user agent folders of other harnesses: `~/.claude/agents`, `~/.config/opencode/agents`, `~/.cursor/agents`, `~/.copilot/agents` and `~/.gemini/agents`. Each item MUST give the id that an import gives, the description, the harness and the path. An item whose id an agent has already MUST carry a conflict. A file that does not convert MUST show as a problem. The find MUST NOT write.

#### Scenario: A taken id

- **GIVEN** `~/.gemini/agents/planner.md`
- **WHEN** the user runs `inflexa agent find`
- **THEN** the list has `planner` from Gemini CLI with a conflict, because the built-in planner has the id

### Requirement: Clone copies an agent of each role

`inflexa agent clone <id> <new-id>` MUST write `agents/<new-id>.md` with the role, the prompt body, the description and the resolved attachments of the agent `<id>`. The clone MUST have no link to its source. A user can clone a built-in agent of each role and a custom agent.

#### Scenario: A clone of the chat agent

- **WHEN** the user clones `inflexa` to `terse-chat`
- **THEN** `agents/terse-chat.md` has the role `chat` and the prompt body of `inflexa`, and the chat agent stays `inflexa` until the user chooses `terse-chat`

#### Scenario: A clone keeps the attachments

- **GIVEN** a `builtin` change that adds the MCP server `lims` to `analyst`
- **WHEN** the user clones `analyst` to `my-analyst`
- **THEN** `agents/my-analyst.md` holds the prompt of `analyst`, its connectors, its skills and `lims`

#### Scenario: A release does not change a clone

- **GIVEN** a clone of `analyst`
- **WHEN** a release changes the prompt of `analyst`
- **THEN** the file of the clone is unchanged

### Requirement: The user chooses the agent of a role

`inflexa agent use <id>` MUST make the agent `<id>` the active agent of its role, through `PUT /api/v1/catalog/roles/<role>`. The config MUST hold the choice as `roles.<role>`. A choice of the built-in agent of the role MUST clear the entry. The removal of a chosen agent MUST clear its entry. An executor needs no choice, because each enabled executor is available to the plans.

#### Scenario: A clone becomes the planner

- **GIVEN** a clone `lab-planner` of `planner`
- **WHEN** the user runs `inflexa agent use lab-planner`
- **THEN** `config.json` holds `roles.planner: "lab-planner"`, and the next plan uses the prompt of `lab-planner`

### Requirement: The description and the prompt of a custom agent are editable

`PATCH /api/v1/catalog/agents/<id>` with a `prompt` MUST replace the body of the file of a custom agent and keep its frontmatter. The same request with a `description` MUST replace the description in the frontmatter and keep the body. `inflexa agent set <id> --description <text> --prompt <text>` MUST send the same request. A request for a built-in agent MUST be refused, because a built-in agent is read-only.

#### Scenario: The GUI edits a clone

- **GIVEN** a clone `lab-planner`
- **WHEN** a client sends a new prompt for `lab-planner`
- **THEN** the file holds the new body under the same frontmatter

#### Scenario: The chat agent describes a new executor

- **GIVEN** a clone `lipidomics-analyst` of `analyst`
- **WHEN** the chat agent runs `inflexa agent set lipidomics-analyst --description "Lipidomics."`
- **THEN** the file holds the new description with the same body, and the next plan reads it

### Requirement: A clone takes a description

`inflexa agent clone <id> <new-id> --description <text>` MUST write the new agent with that description in place of the description of the source.

#### Scenario: A clone with a description

- **WHEN** the user clones `analyst` to `lipid-analyst` with `--description "Lipidomics."`
- **THEN** `agents/lipid-analyst.md` has the description `Lipidomics.` and the prompt body of `analyst`

### Requirement: A chat edits a custom agent with no file outside its workspace

`inflexa agent show` MUST print the prompt body. `inflexa agent set --prompt-file <path>` MUST read the prompt body from a file. With `--analysis`, a relative path MUST read inside the workspace of that analysis, and a linked file or a file larger than 256 KiB MUST be refused. `inflexa agent clone --use` MUST make the new agent the active agent of its role.

#### Scenario: The chat adds a rule to a copy of the chat agent

- **WHEN** the chat clones `inflexa` with `--use`, reads the prompt with `agent show`, writes it with one more rule to `prompts/sketch.md`, and runs `agent set inflexa-sketch --prompt-file prompts/sketch.md`
- **THEN** each call runs with no approval prompt, and the next message uses the new prompt

