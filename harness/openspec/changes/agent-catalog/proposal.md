# Proposal

## Why

The harness fixes its agents, skills and tool sets at build time. `SANDBOX_AGENT_META` is a static record. The plan schema builds its agent enum when the module loads. The skills come from one `skillsDir`, and the keys of the outside services come in as one `BioToolKeys` value. Thus a host cannot give a user or an organization its own agents, skills, connectors or MCP servers. The local CLI must let a user add them, and a managed host must give each organization its own set. Both hosts share one harness, so the harness must take this set as a first-class input.

## What Changes

- Add `AgentCatalog`, a required boot dependency. The host supplies the agent entries, the skills, the MCP servers, the connector settings and the credentials. The harness reads the catalog when a plan is made and when a run starts.
- Add the agent types: `AgentEntry` (a built-in agent with its changes, or a custom agent with its definition), `CustomAgent`, `AgentAttachments`, and the roles. The harness owns the types. It does not parse an agent file.
- Ship each built-in agent as a definition in code: `inflexa`, `planner`, `analyst`, `drug-analyst`, `data-profiler`, `synthesizer`, `analogy` and `reporter`. A host can add or remove the attachments of each one, but it cannot change a prompt. A host can turn off only `drug-analyst` and `analogy`.
- Write the identity of each agent (id, name, role, prompt, prompt hash) into the workflow input. A recovery keeps the prompt and uses the tools that are available at the time of the recovery.
- Build the planner catalog and the two `agent` fields (plan and ad hoc) from the enabled executors of the catalog. The planner prompt names no agent.
- Add `SkillStore`, a reader of skill files. Skills get flat ids from the frontmatter `name` and YAML frontmatter (the Agent Skills standard). Each role gets the skill tools.
- Add an MCP client. MCP tools run on the host as direct tools of the agents that attach the server. stdio and Streamable HTTP are supported, with each protocol version.
- Add connectors: `defineConnector` bundles the shipped tools that reach an outside service, with an optional endpoint and named credentials. Each outside-service tool becomes a connector.
- Record the agent id, the agent name and a hash of its prompt on each step.
- **BREAKING** Remove `SANDBOX_AGENT_META`, `PLANNABLE_AGENT_CATALOG`, `AD_HOC_AGENT_IDS`, `BioToolKeys` and the `skillsDir` and `bioKeys` inputs. The CLI must supply an `AgentCatalog`.
- **BREAKING** Remove the boot-time skill validation. Content checks of the built-in content run in CI. Custom content never stops the boot.

## Capabilities

### New Capabilities

- `agent-catalog`: the `AgentCatalog` boot dependency, the agent types, the roles and the built-in agents. It also covers the resolution, the agent identity of a workflow, and the recovery.
- `skill-store`: the `SkillStore` reader, the skill identity and format, and the skill tools of each role.
- `mcp-client`: the MCP servers that a host supplies, the transport, the tool names, approval, and the output.
- `connectors`: the connector definition, the initial connector set, the endpoint and credential settings, and the attachment of a connector to an agent.

### Modified Capabilities

- `agent-roster`: the catalog comes from `AgentCatalog`, not from `SANDBOX_AGENT_META`. The planner routes by the description of each executor, not by rules that name agents.
- `agent-skill-assignment`: skills come from attachments and the `SkillStore`. The ids are flat. The boot-time validation is removed.
- `harness-sandbox-agents`: the planner catalog derives from the resolved catalog.
- `per-agent-tool-allowlist`: a built-in agent declares its default connectors. The role gives the tools that every executor has.
- `planning-enhancements`: the planner prompt gets the catalog of the enabled executors when a plan is made.
- `adhoc-analysis-execution`: the ad hoc `agent` names an enabled executor of the catalog.
- `harness-durable-runtime`: the boot sequence has no skill validation step.
- `harness-embedder-exports`: `BioToolKeys` leaves the root barrel. The catalog types join it.

## Impact

- Code: `src/agents/sandbox/*`, `src/agents/sandbox-catalog.ts`, `src/agents/conversation-agent.ts`, `src/agents/report-session-agent.ts`, `src/tools/sandbox/skills.ts`, `src/tools/bio/keys.ts` and each keyed tool, `src/tools/execute-analysis.ts`, `src/tools/research/generate-plan.ts`, `src/prompts/planner.ts`, `src/schemas/plan-schemas.ts`, `src/workflows/execute-analysis.ts`, `src/workflows/sandbox-step.ts`, `src/runtime/boot.ts`, `src/runtime/assemble.ts`, `src/index.ts`.
- New dependency: `@modelcontextprotocol/client` (SDK v2). Refer to `docs/mcp-client-research.md`.
- State: the step row records the agent name and the prompt hash. The workflow input holds the identity of each agent.
- Embedders: the CLI must build an `AgentCatalog` (refer to the CLI change `local-customization`). A managed host builds one per organization.
- Skills: `skills/shared/omics-general` becomes `skills/omics-general`. `version` and `tags` move under `metadata` in each `SKILL.md`.
