# Design

## Context

Today the harness builds its agents from a static record (`src/agents/sandbox/index.ts`). The planner catalog and the plan enum come from that record when the module loads (`src/agents/sandbox-catalog.ts`, `src/schemas/plan-schemas.ts`). The only entry point for a host is `SandboxStepDeps.buildAgent` (`src/workflows/sandbox-step.ts`), and the planner never sees what it returns. The tool set of an executor is a closed `SandboxToolName` union, and the keys of the outside services come in as one `BioToolKeys` value. The chat agent has no skill tools.

Two hosts use the harness. The local CLI reads the user content from files. A managed host (Cortex) serves each organization from its database. The two hosts must give the same content to the same harness.

Research for this design:

- `docs/mcp-client-research.md`: the MCP protocol versions, the SDK, the transports, the tool names and the durability risks.
- `docs/agent-format-research.md`: the agent file formats of other harnesses and the Agent Skills standard.

## Goals and Non-Goals

Goals:

- Make the agent catalog a required input of the harness, equal in weight to the provider.
- Let a host add executors and attach skills, connectors and MCP servers to each agent.
- Keep a run reproducible when the host content changes during the run.
- Keep the harness free of paths, files and databases of the host.

Non-goals:

- The agent file format, drafts, import and the config layout. The CLI owns them (change `local-customization`).
- A model per agent. The role models of the host choose the model.
- The policy of `run_inflexa` for the new commands. A later self-configuration change owns it.
- Changes to the skill content guidance (`when_to_use`, skills kept through compaction). Another change owns them.
- A cloud realization of the catalog.

## Decisions

### D1. The roles and the built-in agents

Each agent has one role:

| Role | Built-in agents | Custom agents | Can turn off |
|---|---|---|---|
| `chat` | `inflexa` | no | no |
| `planner` | `planner` | no | no |
| `executor` | `analyst`, `drug-analyst` | yes | yes, except `analyst` |
| `profiler` | `data-profiler` | no | no |
| `synthesizer` | `synthesizer` | no | no |
| `analogy` | `analogy` | no | yes |
| `reporter` | `reporter` | no | no |

Each built-in agent is a catalog entry. The user can add and remove its connectors, MCP servers and skills, and cannot change its prompt. `analyst` is the fallback executor, so it is always on. Only the `executor` role holds more than one agent. A plan or a run cannot proceed without the planner, the profiler or the synthesizer. Thus only `analogy` and the executors other than `analyst` can be turned off.

The role gives a fixed set of tools, the role tools. For an executor, the role tools are the workspace tools, the sandbox lease tools, `inspect_data_profile`, `read_tool_output`, `report_blocker`, `submit_file_metadata`, `link_packages`, `list_available_packages`, `list_available_refs` and the skill tools. An agent file never names a role tool.

### D2. The harness owns the types, the host owns the format

The harness exports the types and never parses a file:

```ts
type AgentEntry =
  | { kind: "builtin"; id: BuiltinAgentId; enabled: boolean;
      add: AgentAttachments; remove: AgentAttachments }
  | { kind: "custom"; enabled: boolean; definition: AgentDefinition };

type AgentDefinition = {
  id: string;
  name: string;
  role: "executor";
  description: string;
  prompt: string;
} & AgentAttachments;

type AgentAttachments = {
  connectors: readonly string[];
  mcp: readonly string[];
  skills: readonly string[];
};

interface AgentCatalog {
  agents(): Promise<readonly AgentEntry[]>;
  skills: SkillStore;
  mcpServers(): Promise<readonly McpServerConfig[]>;
  connectors(): Promise<readonly ConnectorSettings[]>;
  credential(name: string): Promise<string | undefined>;
}
```

A built-in entry holds only the changes. The release owns the base, so a release that adds a connector to the analyst reaches each user who did not remove it. A built-in agent that has no entry runs with the release defaults. A custom entry holds the whole agent.

Alternative: the harness parses the Markdown file. Rejected, because only the CLI reads files, and Cortex stores rows.

### D3. The catalog is read when it is used

The harness reads the catalog at three points:

- when the planner makes a plan
- when a run starts
- when a chat turn starts

The harness keeps no catalog state between these reads. Thus a host can change the catalog at any time, and a managed host needs no event bus between its processes.

`resolveCatalog(catalog)` merges the built-in agents with the entries. It gives the resolved agents and a list of gaps. A gap is a reference that does not resolve, for example an unknown connector, MCP server or skill, or an id that two entries use. A gap removes only the reference, or the entry for a duplicate id. A gap never stops the boot or a run. The host shows the gaps.

### D4. A workflow keeps the identity of each agent, not its environment

A recovery cannot always rebuild the environment of the first run: a user can remove an MCP server, turn off a connector or delete a skill during the run. Thus the recovery uses what is available.

When a workflow starts an agent, it writes the identity of the agent into its input: `id`, `name`, `role`, `prompt` and `promptHash`. The prompt is text, so it is always available, and a recovered step keeps its instructions. The identity holds no attachments, no secret and no server config. A record of the attachments is not kept, because the provenance already records each tool call that ran.

A recovery resolves the tools from the catalog at the time of the recovery:

- A connector, an MCP server or a skill that is still available is attached.
- One that is gone is absent, as for any absent resource.
- A recorded call of a tool that is gone must replay its recorded result. A new call of such a tool returns `unavailable`.

DBOS replays a step by its position and its name, and each tool call is a step `<tool>.<toolCallId>` (`src/loop/tool-adapter.ts`). A recorded call can name a tool that the recovery does not have. Then the AI SDK can answer the call outside a step, and the replay can fail on a mismatch. A probable fix is a placeholder tool for each tool name of the history that the catalog no longer gives. Task 6.4 makes sure of the behavior before the fix is chosen.

A step whose agent is absent, off, or a draft when the run starts refuses the launch. The refusal names the step and the agent.

### D5. The planner sees the enabled executors

The planner prompt gets the id and the description of each enabled executor when the plan is made. The plan `agent` field is a string. The plan validation accepts only an id from that list. The planner prompt has no routing rule that names an agent, because a user can add or remove executors.

The ad hoc `agent` field of `execute_analysis` is also an id from the enabled executors. The default is `analyst`. The chat agent gets the list when its turn starts.

### D6. Skills

`SkillStore` replaces `skillsDir`:

```ts
interface SkillStore {
  list(): Promise<readonly SkillInfo[]>;          // name, description
  files(skill: string): Promise<readonly string[]>;
  read(skill: string, path: string): Promise<string | undefined>;
}
```

The skill id is the frontmatter `name`, and it matches the directory name (the Agent Skills standard). The frontmatter is YAML. `shared/omics-general` becomes `omics-general`. The host makes sure that a user skill does not use a built-in name.

Each role gets `skill_search`, `skill_read` and an index of its attached skills in its system prompt. `skill_read` with no `path` returns `SKILL.md`.

### D7. MCP

The harness holds the MCP client (`@modelcontextprotocol/client`, SDK v2). It accepts each protocol version. The host gives each server config:

```ts
type McpServerConfig = {
  name: string;
  transport:
    | { kind: "stdio"; command: string; args: readonly string[]; env: Record<string, string> }
    | { kind: "http"; url: string; headers: Record<string, string>; auth?: OAuthClientProvider };
  approval: "always" | "never";
  scriptable: boolean;
};
```

The host resolves each credential reference before it gives the config. A managed host gives only `http` servers.

- **Where the calls run.** Each MCP call runs in the harness process on the host, as one durable step. The sandbox never reaches an MCP server.
- **Connections.** The harness connects to a server at its first use and keeps the connection for the process. It connects again when the config changes. It closes the connections at shutdown.
- **Tool names.** A tool name is `mcp__<server>__<tool>`. Each character outside `[a-zA-Z0-9_-]` becomes `_`. A name longer than 64 characters is cut, and it ends with a short hash. The limit of 64 characters is the lowest limit of the supported providers.
- **Approval.** With `approval: "always"`, each call goes through the existing tool-approval gate. The harness does not trust the annotations of a server.
- **Scripts.** A tool is a direct tool. With `scriptable: true`, the tool is also a script tool under `run_script`. `run_script` refuses a tool that needs approval, so `scriptable` needs `approval: "never"`.
- **Output.** The text blocks become the tool output, and `structuredContent` becomes JSON. An image or a resource becomes one line that names its type. `isError` becomes a tool error. The output cap of the loop applies.
- **Absent servers.** If a server does not answer when the agent is built, its tools are absent. The harness logs a warning. The agent continues with the tools that it has.

The OAuth flow and the token storage belong to the host. The harness takes an `OAuthClientProvider` from the SDK. If a token is expired and cannot refresh, the call returns a tool error that tells the user to sign in again.

### D8. Connectors

A connector is a bundle of shipped tools that reach one outside service, with its settings:

```ts
defineConnector({
  id: "drug-gene-interactions",
  description: "Drug–gene interactions from DGIdb, DrugBank and PharmGKB.",
  tools: [drugGeneInteractionsTool],
  credentials: { drugbank: { required: false, unlocks: "DrugBank" } },
  endpoint: undefined,
});
```

The connector registry is in the harness, and it is closed: a host cannot define a connector. The host gives the settings of each connector: `enabled`, an optional endpoint, and the credential name of each slot. A tool reads its credential through `catalog.credential(name)` when it runs. Thus one credential, for example the NCBI key, serves each connector that names it.

The initial set has one connector for each tool that reaches an outside service. The team groups and prunes them later. A tool with a missing required key behaves as today: it stays attached, and the call returns an error that names the key.

A connector that is off is absent for each agent. A connector that is on is present only for the agents that attach it.

The default attachments of each built-in agent are its tool sets of today, expressed as connectors. This rule includes the planner, the profiler, the synthesizer and the analogy agent.

Alternative: attach single tools. Rejected, because a user sees connectors and MCP servers, never tools.

### D9. The identity of the agent of a step

Each step records the agent id, the agent name and a SHA-256 hash of the prompt. The step row and the `step_completed` provenance event carry them. Calls to MCP servers and connectors get no new event.

## Risks and Trade-offs

- **MCP under the compiled Bun binary.** The SDK tests stdio under Node only. Mitigation: a spike task that starts a stdio server from `bun build --compile` before the client work.
- **Duplicate side effects.** MCP gives no idempotency guarantee. A recovery runs an interrupted step again, so a tool with a side effect can act two times. Mitigation: the CLI shows a warning when a user adds a server.
- **Identity size.** The prompt adds to the workflow input, about ten kilobytes for each agent.
- **A recovery with fewer tools.** A recovered step can lose a tool that it used before. The model then gets `unavailable` for a new call and continues with the tools it has.
- **Prompt cache.** The ad hoc tool and the planner prompt change when the executors change. The cache resets only when the user changes the catalog.
- **Plan drift.** A user can remove an executor after a plan names it. The launch refuses the plan and names the step.

## Migration

- The CLI must supply an `AgentCatalog` in the same release. The harness drops `skillsDir`, `bioKeys` and `buildAgent`.
- A run that is in flight during the upgrade has no agent identity. The deploy drains the runs first, as for the analyst change.
- `skills/shared/omics-general` moves to `skills/omics-general`. Each `SKILL.md` moves `version` and `tags` under `metadata`.

## Open Questions

None for the harness. Each role can attach connectors, MCP servers and skills. The reporter and `inflexa` have no default connectors beyond their tool sets of today.
