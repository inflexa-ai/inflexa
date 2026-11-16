# Proposal

## Why

The harness change `agent-catalog` makes the agent catalog a required input. The CLI must supply that catalog from content that the user owns. A user must be able to add executors, skills, connectors and MCP servers, and to change the attachments of the built-in agents. The user must be able to edit each file in a text editor. The TUI, a future GUI and the chat agent must use one surface of commands and `/api/v1` routes.

## What Changes

- Read custom agents from `~/.config/inflexa/agents/<id>.md`. Each file is YAML frontmatter plus the prompt. The field names are those of Claude Code subagents, plus `role`.
- Keep an agent file that does not resolve as a draft. A draft shows its gaps and never reaches the harness.
- Import an agent file from another harness. The import rewrites the tool names, maps the MCP tool names to servers, and drops `model`.
- Read custom skills from `~/.config/inflexa/skills/<name>/`, beside the built-in skills. A custom skill cannot use a built-in name.
- Add config blocks to `config.json`: `agents` (the changes to each built-in agent), `mcp`, `connectors` and `credentials`. The config holds only references to secrets, never a secret value.
- Store each MCP OAuth token in the macOS Keychain, with a `0600` file as the fallback. On Linux and Windows, use the `0600` file. Key each token by its endpoint.
- Add the commands `inflexa agent`, `inflexa skill`, `inflexa connector` and `inflexa mcp`, each backed by an `/api/v1` route.
- Group the commands of the root help, and move the Paths and Environment tables out of the root help.
- Build the `AgentCatalog` at the composition root, and give it to `bootHarness`.
- **BREAKING** Move the keys of `harness.bioKeys` to `credentials` and `connectors`. The CLI stops passing `bioKeys` and `skillsDir` to the harness.

## Capabilities

### New Capabilities

- `custom-agents`: the agent files, their format, drafts and gaps, and the import of foreign agent files.
- `custom-skills`: the user skills directory, the name rule, and `skill find` and `skill import`.
- `customization-config`: the `agents`, `mcp`, `connectors` and `credentials` blocks of `config.json`.
- `mcp-sign-in`: the OAuth sign-in of an MCP server and the storage of its tokens.
- `customization-commands`: the commands and the `/api/v1` routes for agents, skills, connectors and MCP servers, with the agent policy of each command.

### Modified Capabilities

- `harness-runtime`: the composition root builds the `AgentCatalog` and gives it to the harness.
- `cli-core`: the root help groups its commands and leaves out the Paths and Environment tables.

## Impact

- Code: `src/lib/config.ts`, `src/lib/credential.ts`, `src/modules/harness/config.ts`, `src/modules/harness/runtime.ts`, `src/modules/harness/run_deps.ts`, `src/cli/index.ts`, `src/server/app.ts` and new route, client and module files for each command group.
- Depends on the harness change `agent-catalog` and on the harness release that ships it.
- No new dependency: the CLI parses the frontmatter with `Bun.YAML.parse`, which `setup_answers.ts` already uses.
- Config: the CLI stops reading `harness.bioKeys`, with no automatic migration. A user who set a key there must declare it again as a credential.
- Docs: the CLI reference docs gain the new commands.
