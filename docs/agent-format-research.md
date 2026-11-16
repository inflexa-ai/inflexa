# Research: agent files and skills from other harnesses, for an import into Inflexa

> This document is research for a GitHub issue and for an OpenSpec change. It
> gives the facts and the open points. It is not a design.
>
> Sources: the official documents of Claude Code, the Claude Agent SDK,
> OpenCode, Codex, Cursor, GitHub Copilot, VS Code, Gemini CLI, and the Agent
> Skills specification, and inflexa `main` at `2722f886`. Each claim has a URL.
> Researched 2026-11-12.

## 1. The questions and the answers

1. **Which agent file formats exist?** Most harnesses use one Markdown file with
   YAML frontmatter, and the body is the system prompt. Codex is the exception:
   it uses one TOML file for each agent. Section 2 gives the facts.
2. **Which tool names do they use?** Each harness has its own vocabulary. GitHub
   Copilot publishes an alias table that maps the Claude Code names to its own
   names. Section 3 gives the vocabularies, and section 4 gives a draft mapping
   to Inflexa.
3. **What is the Agent Skills standard?** A skill is a directory with a
   `SKILL.md` file. The file has YAML frontmatter with six fields. The Inflexa
   parser reads one field line by line, and the Inflexa skills add two fields
   that the standard does not have. Section 5 gives the facts.
4. **When does Claude Code read `CLAUDE.md` and the agent files again?**
   Section 6 gives the answer.

## 2. Agent file formats

### 2.1 Claude Code subagents

- **Location.** `.claude/agents/` for a project and `~/.claude/agents/` for a
  user. The managed settings, the `--agents` flag, and the `agents/` directory of
  a plugin are other sources. A higher source wins when two agents have the same
  name. <https://code.claude.com/docs/en/sub-agents>
- **Name.** Claude Code scans the two directories recursively. The identity
  comes only from the `name` field, not from the file name.
  <https://code.claude.com/docs/en/sub-agents>
- **Required fields.** `name` (a maximum of 256 characters, no `:`) and
  `description`. <https://code.claude.com/docs/en/sub-agents>
- **Optional fields.** `tools`, `disallowedTools`, `model`, `permissionMode`,
  `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`,
  `background`, `omitClaudeMd`, `effort`, `isolation`, `color`,
  `initialPrompt`, `experimental`. Claude Code ignores a field that it does not
  know, and it gives no error. <https://code.claude.com/docs/en/sub-agents>
- **Tools.** `tools` is a comma-separated string, for example
  `Read, Grep, Bash`, or a YAML list. If `tools` is absent, the agent gets each
  tool that is available to subagents. `Agent(worker, researcher)` limits which
  agents an agent can start. <https://code.claude.com/docs/en/sub-agents>
- **The old name of the agent tool.** Claude Code 2.1.63 changed the name of
  the `Task` tool to `Agent`. `Task(...)` is still an alias.
  <https://code.claude.com/docs/en/sub-agents>
- **MCP tools.** The name of an MCP tool is `mcp__<server>__<tool>`.
  `mcp__github__*` gives each tool of one server. In `disallowedTools`,
  `mcp__github` removes one server and `mcp__*` removes all MCP tools. If a
  server name contains `__`, the trailing `__*` is necessary.
  <https://code.claude.com/docs/en/sub-agents>
- **MCP servers.** `mcpServers` is a list. An item is the name of a server that
  the user configured, or an inline server definition with `type`, `command`,
  and `args`. Claude Code ignores `mcpServers`, `hooks`, and `permissionMode` for
  a plugin agent. <https://code.claude.com/docs/en/sub-agents>
- **Skills.** `skills` is a list of skill names. Claude Code puts the full
  content of each listed skill into the context of the agent at startup, up to
  32 names. Without the field, the agent can still find and use skills with the
  `Skill` tool. <https://code.claude.com/docs/en/sub-agents>
- **Model.** `sonnet`, `opus`, `haiku`, `fable`, a full model ID, or `inherit`.
  <https://code.claude.com/docs/en/sub-agents>

### 2.2 Claude Agent SDK

- An `AgentDefinition` object has the same fields as a subagent file. The
  system prompt is the `prompt` field, and the name is the key of the `agents`
  map. `description` and `prompt` are required.
  <https://code.claude.com/docs/en/agent-sdk/typescript>
- `disallowedTools` accepts `mcp__server`, `mcp__server__*`, and `mcp__*`.
  <https://code.claude.com/docs/en/agent-sdk/typescript>
- The SDK also reads the files in `.claude/agents/`. An agent in code wins over a
  file agent with the same name.
  <https://code.claude.com/docs/en/agent-sdk/subagents>

### 2.3 OpenCode

- **Location.** `~/.config/opencode/agents/<name>.md` and
  `.opencode/agents/<name>.md`, or the `agents` key of a configuration file. The
  agent ID comes from the file path, for example `team/reviewer`.
  <https://opencode.ai/docs/agents/>
- **Fields (V2).** `description`, `mode` (`primary`, `subagent`, or `all`),
  `model`, `system`, `permissions`, `steps`, `hidden`, `color`, `disabled`,
  `request`. In a Markdown file, the body is the system prompt.
  <https://opencode.ai/docs/agents/>
- **Old fields.** The document tells you not to use `temperature`, `top_p`,
  `prompt`, `permission`, `tools`, `disable`, or `maxSteps` in a V2 agent. It
  says that the V1 frontmatter fields are deprecated. Thus an old file can still
  have a `tools` map. <https://opencode.ai/docs/agents/>
- **Tools.** The `permissions` field is an ordered list of rules with `action`,
  `resource`, and `effect` (`allow`, `ask`, or `deny`). The last rule that
  matches wins. The actions include `shell`, `edit`, `subagent`, `read`, `glob`,
  `grep`, `webfetch`, `websearch`, and `skill`.
  <https://opencode.ai/docs/agents/>
- **MCP tools.** The permission action of an MCP tool is `<server>_<tool>`. By
  default, an agent calls MCP tools through the `execute` tool (Code Mode).
  <https://opencode.ai/docs/tools/>
- **Model.** `provider/model`, with an optional `#variant`, for example
  `anthropic/claude-sonnet-5-5#high`. <https://opencode.ai/docs/agents/>

### 2.4 Codex

- **Location and format.** One TOML file for each agent, in `~/.codex/agents/`
  or `.codex/agents/`. Codex finds the agent by its `name` field, not by the
  file name. <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- **Required fields.** `name`, `description`, `developer_instructions` (the
  prompt). **Optional fields.** `model`, `model_reasoning_effort`,
  `model_reasoning_summary`, `model_verbosity`.
  <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- **Tools.** The file has no tool list. You can turn off a feature, for example
  `features.shell_tool = false`. MCP servers come from the parent session.
  `sandbox_mode`, `approval_policy`, `model_provider`, and `mcp_servers` in an
  agent file do not override the parent.
  <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- **Skills.** An agent gets the skills of the parent. `skills.config` turns off
  one skill. <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- **AGENTS.md.** `AGENTS.md` is an instruction file for each directory, not a
  file for each agent. <https://learn.chatgpt.com/docs/agent-configuration/agents-md>

### 2.5 Cursor

- **Location.** `.cursor/agents/` and `~/.cursor/agents/`. Cursor also reads
  `.claude/agents/`, `~/.claude/agents/`, `.codex/agents/`, and
  `~/.codex/agents/`. `.cursor/` wins when two agents have the same name.
  <https://cursor.com/docs/context/subagents>
- **Fields.** `name` (lowercase letters and hyphens, the file name by default),
  `description`, `model` (`inherit` by default), `readonly`, `is_background`.
  The document gives no tool list field. A subagent gets each tool of the parent,
  with the MCP tools. <https://cursor.com/docs/context/subagents>
- **Model.** `inherit`, a model ID, or a model ID with parameters, for example
  `claude-opus-5[effort=high,context=300k]`.
  <https://cursor.com/docs/context/subagents>

### 2.6 GitHub Copilot and VS Code

- **Location.** `.github/agents/NAME.agent.md` in a repository, and
  `agents/NAME.agent.md` in the `.github` or `.github-private` repository of an
  organization.
  <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents>
  VS Code also reads `~/.copilot/agents/`, and it reads `.claude/agents/` and
  `~/.claude/agents/` in the Claude format. A `.chatmode.md` file must get the
  new name `.agent.md`.
  <https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference>
- **Fields.** `name`, `description` (required), `target`, `tools`, `model`,
  `disable-model-invocation`, `user-invocable`, `mcp-servers`, `metadata`.
  `infer` is retired. VS Code does not use `mcp-servers` and `metadata`.
  <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
  VS Code adds `argument-hint`, `agents`, `model-policy`, `reasoning-effort`,
  `skills`, `handoffs`, `hooks`, and other fields.
  <https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference>
- **Tools.** A comma-separated string or a YAML list. `*` or no field gives all
  tools, and `[]` gives none. Copilot ignores a tool name that it does not know.
  <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- **MCP tools.** `server/tool` for one tool and `server/*` for each tool of a
  server. <https://docs.github.com/en/copilot/reference/custom-agents-configuration>
- **Claude files.** VS Code "maps supported Claude tool and model names to their
  VS Code equivalents". The document does not give the map.
  <https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference>
- **Model.** A string, or a list in the order of preference (VS Code).
  <https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference>

### 2.7 Gemini CLI

- **Location.** `.gemini/agents/*.md` and `~/.gemini/agents/*.md`. The body is
  the system prompt.
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md>
- **Fields.** `name` (required, lowercase letters, numbers, hyphens, and
  underscores), `description` (required), `kind` (`local` or `remote`), `tools`,
  `mcpServers` (inline servers for this agent only), `model` (`inherit` by
  default), `temperature`, `max_turns` (30 by default), `timeout_mins` (10 by
  default).
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md>
- **Tools.** A YAML list. `*` gives all tools, `mcp_*` gives all MCP tools, and
  `mcp_<server>_*` gives the tools of one server. If `tools` is absent, the agent
  gets each tool of the parent. A subagent cannot call a different subagent.
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md>

### 2.8 Summary

| Harness | Format | Name from | Tool field | MCP tool reference | Skills field |
| --- | --- | --- | --- | --- | --- |
| Claude Code, Agent SDK | Markdown, YAML | `name` | `tools`, `disallowedTools` | `mcp__<server>__<tool>` | `skills` (preload) |
| OpenCode | Markdown, YAML | file path | `permissions` (V1: `tools`) | action `<server>_<tool>` | `skill` permission |
| Codex | TOML | `name` | none (`features.*`) | from the parent | `skills.config` |
| Cursor | Markdown, YAML | `name` or file name | none (`readonly`) | from the parent | not documented |
| GitHub Copilot, VS Code | Markdown, YAML | file name | `tools` | `<server>/<tool>` | `skills` (VS Code) |
| Gemini CLI | Markdown, YAML | `name` | `tools` | `mcp_<server>_*` | not documented |

## 3. Built-in tool names

- **Claude Code.** <https://code.claude.com/docs/en/tools-reference>
  - Files: `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `LSP`.
  - Commands: `Bash`, `PowerShell`, `Monitor`.
  - Web: `WebFetch`, `WebSearch`.
  - Agents and skills: `Agent` (old name `Task`), `SendMessage`, `Skill`.
  - Tasks: `TaskCreate`, `TaskGet`, `TaskList`, `TaskStop`, `TaskUpdate`, `TodoWrite`.
  - Schedules: `CronCreate`, `CronDelete`, `CronList`.
  - Session: `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`.
  - MCP: `ListMcpResourcesTool`, `ReadMcpResourceTool`, `ToolSearch`.
  - Other tools of the product, for example `Artifact` and `PushNotification`.
- **OpenCode.** `read`, `glob`, `grep`, `edit`, `write`, `patch`, `shell`,
  `webfetch`, `websearch`, `question`, `skill`, `subagent`, `execute`.
  <https://opencode.ai/docs/tools/>
- **Gemini CLI.** `run_shell_command`, `glob`, `grep_search`, `list_directory`,
  `read_file`, `read_many_files`, `write_file`, `replace`, `ask_user`,
  `write_todos`, `activate_skill`, `get_internal_docs`, `enter_plan_mode`,
  `exit_plan_mode`, `google_web_search`, `web_fetch`, `complete_task`, and the
  `tracker_*` tools.
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md>
- **GitHub Copilot aliases.** The names are not case-sensitive.
  <https://docs.github.com/en/copilot/reference/custom-agents-configuration>

  | Copilot alias | Other names that Copilot accepts |
  | --- | --- |
  | `execute` | `shell`, `Bash`, `powershell` |
  | `read` | `Read`, `NotebookRead` |
  | `edit` | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` |
  | `search` | `Grep`, `Glob` |
  | `agent` | `custom-agent`, `Task` |
  | `web` | `WebSearch`, `WebFetch` |
  | `todo` | `TodoWrite` |

- **Codex and Cursor.** An agent file of these harnesses does not name tools.
  Thus the mapping table has no row for them.

## 4. Draft mapping table to Inflexa

The Inflexa side has two parts:

- **The allowlist.** `SandboxToolName` is the closed list of tools that an agent
  can declare in `AgentMeta.tools` (`harness/src/agents/sandbox/types.ts:16-69`).
  Each name is a research or biology tool. No foreign vocabulary in section 3
  has a name for one of these tools.
- **The tools that are always on.** `createSandboxAgent` adds the workspace
  tools to each sandbox agent, whatever `AgentMeta.tools` contains:
  `acquire_sandbox`, `release_sandbox`, `execute_command`, `write_file`,
  `edit_file`, `read_file`, `list_files`, `file_stat`, `grep`, and
  `workspace_search` when an embedding is bound
  (`harness/src/agents/sandbox/shared.ts:300-345`). A read-only agent does not
  get `write_file` and `edit_file` (`shared.ts:315-327`). It also adds
  `skill_search` and `skill_read` when a skills directory is set
  (`shared.ts:383,409`). The allowlisted tools outside
  `DIRECT_ALLOWLIST_TOOLS` go to the script tools, not to the direct tools
  (`shared.ts:198,410,423`).

`web_search` and `web_fetch` are tools of the conversation agent, not of a
sandbox agent (`harness/src/agents/conversation-agent.ts:319-320`).

| Foreign name | Closest Inflexa concept |
| --- | --- |
| `Read`, `read`, `read_file`, `NotebookRead` | `read_file` (always on) |
| `read_many_files` | `read_file`, one file for each call |
| `Write`, `write`, `write_file` | `write_file` (always on, except a read-only agent) |
| `Edit`, `MultiEdit`, `edit`, `replace`, `patch` | `edit_file` (always on, except a read-only agent) |
| `NotebookEdit` | no equivalent |
| `Bash`, `shell`, `execute` (Copilot), `run_shell_command` | `execute_command`, in the sandbox, with `acquire_sandbox` |
| `PowerShell`, `powershell` | no equivalent |
| `Grep`, `grep`, `grep_search`, `search` (Copilot) | `grep` |
| `Glob`, `glob`, `list_directory` | `list_files`, `file_stat` |
| `WebSearch`, `websearch`, `google_web_search`, `web` | `web_search` (conversation agent only, when the embedder binds an engine) |
| `WebFetch`, `webfetch`, `web_fetch`, `web` | `web_fetch` (conversation agent only) |
| `Skill`, `skill`, `activate_skill` | `skill_search` and `skill_read` (always on with a skills directory) |
| `Agent`, `Task`, `subagent`, `agent`, `custom-agent` | no equivalent as a tool. The planner gives steps to agents (`AgentMeta.plannable`, `types.ts:82-83`) |
| `execute` (OpenCode Code Mode) | `run_script` (`harness/src/tools/script/run-script.ts:58`) |
| `TodoWrite`, `TaskCreate`, `write_todos`, `todo` | no equivalent for a sandbox agent |
| `AskUserQuestion`, `question`, `ask_user` | no equivalent. A sandbox agent is headless (`shared.ts:350-356`) |
| `EnterPlanMode`, `ExitPlanMode`, `enter_plan_mode`, `exit_plan_mode` | no equivalent |
| `LSP`, `ToolSearch`, `Monitor`, `Cron*`, worktree tools | no equivalent |
| `ListMcpResourcesTool`, `ReadMcpResourceTool` | no equivalent |
| `mcp__<server>__<tool>`, `<server>/<tool>`, `mcp_<server>_*` | no equivalent. `harness/package.json` and `cli/package.json` have no MCP client dependency |

## 5. The Agent Skills standard and the Inflexa skills

### 5.1 The standard

- **Layout.** A skill is a directory with a `SKILL.md` file. `scripts/`,
  `references/`, and `assets/` are optional directories.
  <https://agentskills.io/specification>
- **The file.** `SKILL.md` must have YAML frontmatter, then Markdown.
  <https://agentskills.io/specification>
- **Fields.** <https://agentskills.io/specification>

  | Field | Required | Constraint |
  | --- | --- | --- |
  | `name` | yes | 1 to 64 characters. Lowercase letters, numbers, and hyphens. No hyphen at the start or the end. No `--`. Must be the same as the parent directory name |
  | `description` | yes | 1 to 1024 characters |
  | `license` | no | A license name or a bundled license file |
  | `compatibility` | no | 1 to 500 characters |
  | `metadata` | no | A map from string keys to string values |
  | `allowed-tools` | no | A space-separated string. Experimental |

- **Load in steps.** A client loads `name` and `description` at startup, the
  body when the skill starts, and the other files only when necessary. The body
  must stay below 500 lines. <https://agentskills.io/specification>
- **Lenient parse.** The client guide tells a client to load a skill with a
  warning when the name does not match the directory or is too long. It tells a
  client to skip a skill without a description, or a skill with YAML that it
  cannot parse. Files from other clients often have a colon in a value without
  quotes, and the guide recommends a fallback for this case.
  <https://agentskills.io/client-implementation/adding-skills-support>
- **Directory convention.** `.agents/skills/` and `~/.agents/skills/` are the
  shared directories between clients. The specification does not set a
  location. <https://agentskills.io/client-implementation/adding-skills-support>
- **Strict upload.** A claude.ai upload and the Skills API accept only the six
  fields. Another field causes the error `Unexpected key(s) in SKILL.md
  frontmatter`. <https://code.claude.com/docs/en/skills>

### 5.2 Harnesses that use the standard

- **Claude Code.** It reads the six fields and adds others, for example
  `disable-model-invocation`, `user-invocable`, `disallowed-tools`, `model`,
  `context`, `agent`, `hooks`, and `paths`. `allowed-tools` accepts a string with
  spaces or commas, or a YAML list. <https://code.claude.com/docs/en/skills>
- **OpenCode.** It reads `.opencode/skills`, `.claude/skills`, and
  `.agents/skills`. The ID comes from the path, and `name` is only a label. It
  does not enforce the name rules. <https://opencode.ai/docs/skills/>
- **Gemini CLI.** It reads `.gemini/skills/` and `.agents/skills/`.
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md>
- **Codex.** It reads `.agents/skills`, `$HOME/.agents/skills`, and
  `/etc/codex/skills`. `name` and `description` are necessary. An optional
  `agents/openai.yaml` file holds the UI data, the invocation policy, and the MCP
  dependencies. <https://learn.chatgpt.com/docs/build-skills>
- **VS Code and Copilot.** It reads `.github/skills/`, `.claude/skills/`, and
  `.agents/skills/`. A name with characters that are not permitted causes the
  skill to fail without a message.
  <https://code.visualstudio.com/docs/copilot/customization/agent-skills>

### 5.3 Where Inflexa is different

- **The parse.** `skillDescription` does not parse YAML. It finds the first line
  that starts with `description:` and keeps the remainder of that line
  (`harness/src/tools/sandbox/skills.ts:194-207`). Thus:
  - a block value (`description: >` or `|`) gives the text `>` or `|`.
  - a value in quotes keeps the quotes.
  - a value on more than one line keeps only the first line.
- **The fields that Inflexa reads.** Inflexa reads only `description`. It does
  not read `name`, `license`, `compatibility`, `metadata`, or `allowed-tools`.
  It does not reject an unknown field.
- **The required fields.** Inflexa makes no field necessary. Without a
  description, the skill index shows only the skill ID
  (`skills.ts:214-217`). The standard skips such a skill.
- **The checks at startup.** `validateAgentSkills` only makes sure that each
  declared `SKILL.md` exists
  (`harness/src/agents/sandbox/validate-skills.ts:24-55`).
- **The skill ID.** The ID is a path under `SKILLS_DIR`, and it can have two
  levels, for example `shared/omics-general`
  (`harness/src/agents/sandbox/analyst.ts:17`). The `name` field of that skill
  is `omics-general`, which is the parent directory name. Thus it obeys the
  standard.
- **The extra fields.** Each Inflexa skill has `version` and `tags` at the top
  level, for example `skills/enrichment/SKILL.md:4-5` and
  `skills/dna-methylation/SKILL.md:4-5`. The standard puts extra data in
  `metadata`. A claude.ai upload rejects the two fields.
- **The layout.** The Inflexa skills use `references/` only. No skill has
  `scripts/` or `assets/`.
- **The values.** Each `name` is the same as its directory. Each description is
  on one line and has fewer than 1024 characters.

## 6. When Claude Code reads `CLAUDE.md` and the agent files

### 6.1 An edit of `CLAUDE.md` in a session that runs

- **Project-root and user `CLAUDE.md`.** Claude Code reads these files one time
  at session start and keeps them in memory. An edit does not apply in the
  session. The new content loads on the next `/clear`, `/compact`, or restart.
  <https://code.claude.com/docs/en/prompt-caching>
- **A nested `CLAUDE.md` and a rule with `paths:`.** These files load on demand.
  An edit before the load applies. After the load, the content is part of the
  conversation history, and an edit does not change it.
  <https://code.claude.com/docs/en/prompt-caching>
- **After `/compact`.** Claude Code reads the project-root `CLAUDE.md` from disk
  again. <https://code.claude.com/docs/en/memory>,
  <https://code.claude.com/docs/en/context-window>

### 6.2 A resumed session

- **The system prompt.** Claude Code builds the system prompt on the first
  request and records it in the session. A session resumed with `--resume` or
  `--continue` uses the recorded prompt until the next compaction.
  <https://code.claude.com/docs/en/cli-reference>
- **`CLAUDE.md` is not in the system prompt.** The cache layers put `CLAUDE.md`
  in the "project context" layer, after the system prompt. That layer changes
  when the session starts, or after `/clear` or `/compact`. An edit applies
  after a restart. <https://code.claude.com/docs/en/prompt-caching>
- **The settings files.** Claude Code reads `settings.json` again at launch on a
  resume. <https://code.claude.com/docs/en/sessions>
- **What the documents do not say.** No document says in one sentence that a
  resume reads `CLAUDE.md` again. The facts above show that a resume is a new
  launch and that the project context is not a recorded part of the session.
  Thus the probable behavior is that a resume reads `CLAUDE.md` from disk, but
  this is an inference. A nested `CLAUDE.md` that loaded before is in the
  conversation history, and the resume keeps that old text.

### 6.3 An edit of an agent file

- **In a session that runs.** Claude Code watches `~/.claude/agents/` and
  `.claude/agents/`. It finds a new or changed file in a few seconds, and the
  next delegation uses the new definition. No restart is necessary.
  <https://code.claude.com/docs/en/sub-agents>
- **Exceptions.** A restart is necessary in these conditions
  (<https://code.claude.com/docs/en/sub-agents>):
  - the `agents` directory did not exist at session start.
  - the directory comes from `--add-dir` or `/add-dir`.
  - the session started with `--disable-slash-commands`.
- **A resumed session that runs as an agent.** A session that started with
  `--agent` continues as that agent. Claude Code finds the agent in the original
  directory, then in the current directory. If it finds no agent, the session
  continues with the default tools and shows a warning.
  <https://code.claude.com/docs/en/sessions>
- **Skills.** Claude Code watches the skill directories and finds a change to a
  `SKILL.md` in the session that runs. <https://code.claude.com/docs/en/skills>

## 7. Open points for Inflexa

- **The parser.** An imported `SKILL.md` can have a block value, a value in
  quotes, or a list. The line parser of `skills.ts:194-207` reads these values
  incorrectly. Section 5.3 gives the cases.
- **The extra fields.** The Inflexa skills put `version` and `tags` at the top
  level. A strict client, for example a claude.ai upload, rejects them.
- **The two levels of a skill ID.** `shared/omics-general` has two levels. An
  imported skill has one directory.
- **MCP.** The harness has no MCP client. Each agent that names an MCP tool
  stays a draft until an MCP client exists.
- **The tool vocabularies.** OpenCode V1 files can have a `tools` map, and V2
  files use `permissions`. Codex and Cursor files name no tools.
- **The research tools.** No foreign vocabulary names an Inflexa research tool.
  An imported agent gets the workspace tools only, unless a different source
  gives the `SandboxToolName` values.
- **The model field.** The model names are different in each harness (aliases,
  `provider/model`, lists). Inflexa sets the model of a sandbox agent from
  `deps.model`, not from `AgentMeta` (`shared.ts:418`).
- **The resume of `CLAUDE.md`.** Section 6.2 is an inference. An
  `InstructionsLoaded` hook with the matcher `session_start` can show the
  behavior on a resume (<https://code.claude.com/docs/en/hooks>).

## Sources

- Claude Code subagents: <https://code.claude.com/docs/en/sub-agents>
- Claude Code tools: <https://code.claude.com/docs/en/tools-reference>
- Claude Code skills: <https://code.claude.com/docs/en/skills>
- Claude Code memory: <https://code.claude.com/docs/en/memory>
- Claude Code prompt caching: <https://code.claude.com/docs/en/prompt-caching>
- Claude Code context window: <https://code.claude.com/docs/en/context-window>
- Claude Code sessions: <https://code.claude.com/docs/en/sessions>
- Claude Code CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Claude Code hooks: <https://code.claude.com/docs/en/hooks>
- Claude Agent SDK: <https://code.claude.com/docs/en/agent-sdk/typescript>,
  <https://code.claude.com/docs/en/agent-sdk/subagents>
- OpenCode: <https://opencode.ai/docs/agents/>, <https://opencode.ai/docs/tools/>,
  <https://opencode.ai/docs/skills/>
- Codex: <https://learn.chatgpt.com/docs/agent-configuration/subagents>,
  <https://learn.chatgpt.com/docs/build-skills>,
  <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Cursor: <https://cursor.com/docs/context/subagents>
- GitHub Copilot:
  <https://docs.github.com/en/copilot/reference/custom-agents-configuration>,
  <https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-custom-agents>
- VS Code:
  <https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference>,
  <https://code.visualstudio.com/docs/copilot/customization/agent-skills>
- Gemini CLI:
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md>,
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md>,
  <https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md>
- Agent Skills: <https://agentskills.io/specification>,
  <https://agentskills.io/client-implementation/adding-skills-support>
