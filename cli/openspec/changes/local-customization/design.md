# Design

## Context

The harness change `agent-catalog` (in `harness/openspec/changes/agent-catalog`) defines the `AgentCatalog` types and requires a catalog at boot. The harness owns the types and never reads a file. This change is the CLI realization: the files, the config, the drafts, the import, the sign-in of MCP servers, and the commands.

Today the CLI keeps its config in `~/.config/inflexa/config.json` (`src/lib/config.ts`). It keeps the keys of the outside services as values in `harness.bioKeys` (`src/modules/harness/config.ts:26-36`). `CredentialSource` (`src/lib/credential.ts`) reads a secret from an environment variable or a helper command, but only the model connection uses it. The built-in skills come from `content/<hash>/skills`, or from the repository in a development build.

Research for this design:

- `docs/agent-format-research.md`: the agent formats of other harnesses and their tool names.
- `docs/mcp-client-research.md`: the MCP config formats of other clients.
- The Claude Code credential docs: the Keychain on macOS with a `0600` file as the fallback, and a `0600` file on Linux and Windows.

## Goals and Non-Goals

Goals:

- A user can add or change each customization with a text editor, a command, or a route.
- Custom content never stops the boot.
- The config never holds a secret value.

Non-goals:

- The agent policy of the new commands beyond this change. The self-configuration change revisits it.
- A GUI. The routes are the contract for a future GUI.
- An automatic migration of `harness.bioKeys`.

## Decisions

### D1. The layout on disk

```
~/.config/inflexa/
  config.json
    agents.<builtin-id>   { enabled, add, remove }
    mcp.<name>            { type, command/args/env | url/headers, auth, approval, scriptable }
    connectors.<id>       { enabled, endpoint, credentials: { <slot>: <credential name> } }
    credentials.<name>    { kind: "env", var } | { kind: "command", command, ... }
  agents/<id>.md          custom agents
  skills/<name>/SKILL.md  custom skills
```

The `credentials` entries reuse the `CredentialSource` schema of the model connection. An `env` or `headers` value of an MCP server can hold `${cred:<name>}`, and the CLI resolves it when it builds the catalog.

### D2. The agent file

The file name is `<id>.md`, and the frontmatter `name` must equal `<id>`. The frontmatter uses the field names of Claude Code subagents where a field exists:

```md
---
name: lipid-analyst
description: Lipidomics QC, normalization and class enrichment.
role: executor
connectors: [pubmed, chembl]
mcpServers: [lipidmaps]
skills: [metabolomics, omics-general]
---
The prompt.
```

- `role` is optional, and the default is `executor`.
- `mcpServers` lists server names. The servers are defined in `config.json`. A server defined inline in the frontmatter, as Claude Code allows, becomes a gap.
- `connectors` is an Inflexa field.
- A `tools` field is read only by the import. In a file under `agents/`, `tools` is a gap.
- A `model` field is ignored, because the role models choose the model.

### D3. Drafts

The CLI reads `agents/` when the harness reads the catalog. A file is a draft when one of these conditions is true:

- the frontmatter does not parse
- a required field is missing
- the `name` does not equal the file name
- the id equals a built-in id or the id of another file
- a reference does not resolve (a connector, an MCP server or a skill)

A draft stays on disk and keeps its gaps. `GET /api/v1/agents` returns each draft with its gaps. `agents()` of the catalog leaves out each draft. A draft never stops the boot.

### D4. Import

`inflexa agent import <file>` reads a foreign agent file, converts it, and writes `agents/<id>.md`. The import always succeeds. The conversion does these steps:

1. It keeps `name`, `description` and the prompt body.
2. It drops `model`, `permissionMode` and other fields that Inflexa does not use.
3. It drops the foreign tools that each executor gets from its role: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `TodoWrite`. The table of names lives in the CLI.
4. It maps each MCP tool reference to a server name. It reads the forms `mcp__<server>__<tool>`, `mcp__<server>__*`, `<server>/<tool>`, `mcp_<server>_*` and `<server>_<tool>`. A server that `config.json` does not define becomes a gap.
5. It writes each other tool name to `tools`, which makes the agent a draft until the user removes it.

The import never reads a directory of another harness on its own. The user names the file.

### D5. Custom skills

The CLI builds the `SkillStore` over two roots: the built-in skills and `~/.config/inflexa/skills/`. A custom skill whose `name` equals a built-in name is left out, and `inflexa skill ls` shows the error. `inflexa skill find <dir>` lists the skills in a directory that the user names. `inflexa skill import <dir>` copies a skill directory into `skills/`.

### D6. MCP sign-in

`inflexa mcp auth <name>` runs the OAuth flow of the SDK in the browser. The CLI stores the tokens and the client registration, keyed by the endpoint URL:

- macOS: the Keychain. If the Keychain refuses the write, a `0600` file under `~/.local/share/inflexa/`.
- Linux and Windows: the `0600` file.

`inflexa mcp logout <name>` revokes the tokens where the server supports it, and deletes them. `inflexa mcp rm <name>` deletes the tokens and the config entry. A copy of a config entry carries no token, so a copy always needs its own sign-in.

### D7. Commands, routes and agent policies

| Command | Route | Agent policy |
|---|---|---|
| `agent ls`, `agent show <id>` | `GET /api/v1/agents`, `GET /api/v1/agents/:id` | auto |
| `agent clone <id> <new-id>` | `POST /api/v1/agents/:id/clone` | approval |
| `agent import <file>` | `POST /api/v1/agents/import` | approval |
| `agent enable`, `agent disable` | `PATCH /api/v1/agents/:id` | approval |
| `agent attach`, `agent detach` | `PATCH /api/v1/agents/:id` | approval |
| `agent rm <id>` | `DELETE /api/v1/agents/:id` | approval |
| `skill ls`, `skill find <dir>` | `GET /api/v1/skills` | auto |
| `skill import <dir>` | `POST /api/v1/skills/import` | approval |
| `connector ls` | `GET /api/v1/connectors` | auto |
| `connector set <id>` | `PATCH /api/v1/connectors/:id` | approval |
| `mcp ls` | `GET /api/v1/mcp` | auto |
| `mcp add` | `POST /api/v1/mcp` | blocked |
| `mcp auth`, `mcp logout` | `POST /api/v1/mcp/:name/auth`, `DELETE /api/v1/mcp/:name/auth` | blocked |
| `mcp enable`, `mcp disable`, `mcp rm` | `PATCH`, `DELETE /api/v1/mcp/:name` | approval |
| `credential ls` | `GET /api/v1/credentials` | auto |
| `credential set <name>` | `PUT /api/v1/credentials/:name` | approval |

`mcp add` is blocked for the chat agent, because it makes the host run a command that the agent wrote. `mcp auth` is blocked because the sign-in needs a person at a browser. The self-configuration change revisits each policy.

`agent clone` copies a built-in prompt and its resolved attachments into a new file. The clone has no link to the built-in agent. A user can clone only an executor.

`mcp add` prints a warning: a recovery can call a tool of the server again, so a tool with a side effect can act two times.

### D8. Help groups

The root help groups its commands under headings, for example Analyses, Agents, Data, Provenance and Setup. Commander has `helpGroup()` for this. The Paths and Environment tables move to `inflexa help env`.

## Risks and Trade-offs

- **A user edits a file during a run.** The run keeps its snapshot (harness change), so the edit applies from the next run.
- **Keychain prompts.** macOS can ask the user for access to the Keychain. The file fallback covers a locked Keychain.
- **Loss of `bioKeys` values.** A user who set keys there must declare them again. The release notes must say so.

## Open Questions

- Does the GUI show the `scriptable` option of an MCP server, or only the config file?
