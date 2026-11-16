# Tasks

## 1. MCP spike

- [x] 1.1 Start a stdio MCP server from a `bun build --compile` binary with `@modelcontextprotocol/client`, list its tools and call one. Record the result in `docs/mcp-client-research.md`. Done when: the compiled binary prints the tool result.

## 2. Catalog types and resolution

- [x] 2.1 Add the types `AgentCatalog`, `AgentEntry`, `AgentDefinition`, `AgentAttachments`, `BuiltinAgentId`, `McpServerConfig` and `ConnectorSettings`, and export them from `src/index.ts`. Done when: an embedder fixture imports each name from the root, and the typecheck passes.
- [x] 2.2 Define each built-in agent (`inflexa`, `planner`, `analyst`, `drug-analyst`, `data-profiler`, `synthesizer`, `analogy`, `reporter`) with a name, a role, a description, a prompt and default attachments. Done when: a unit test lists the built-in ids and roles.
- [x] 2.3 Add `resolveCatalog(catalog)`: merge the built-in agents with the entries, apply `add` and `remove`, keep the always-on agents on, and report each gap. Done when: unit tests for each scenario of the `agent-catalog` spec (defaults, a release default, a removed default, a disabled executor, an unknown reference, a duplicate id).
- [x] 2.4 Make `bootHarness` take `catalog`, and remove `skillsDir`, `bioKeys` and `buildAgent` from the boot inputs. Remove the skill validation step. Done when: the boot test passes with a catalog that has a gap.

## 3. Skills

- [x] 3.1 Add `SkillStore` and `SkillInfo`, and parse `SKILL.md` frontmatter as YAML. Done when: unit tests for a block value, a quoted value and a multi-line value.
- [x] 3.2 Build `skill_search`, `skill_read` and the skill index over the `SkillStore`. `skill_read` with no `path` returns `SKILL.md`. Done when: the existing skill tool tests pass against an in-memory store, plus a test for the call with no path.
- [x] 3.3 Give the skill tools and the skill index to `inflexa` and `reporter`. Done when: a test builds each role with one attached skill and reads it.
- [x] 3.4 Move `skills/shared/omics-general` to `skills/omics-general`, and move `version` and `tags` under `metadata` in each `SKILL.md`. Done when: the CI content test of task 3.5 passes.
- [x] 3.5 Add the CI content test: each built-in skill has valid frontmatter, its `name` equals its directory, and each default skill and default connector of each built-in agent exists. Done when: the test fails on a fixture with a typo and passes on the tree.

## 4. Connectors

- [x] 4.1 Add `defineConnector` and the closed connector registry. Define one connector for each tool that reaches an outside service, with its credential slots, its default endpoint and its outside-service name. Done when: a test makes sure that each outside-service tool is in exactly one connector.
- [x] 4.2 Replace `BioToolKeys` with `catalog.credential(name)`, read when each keyed tool runs. Done when: the tests of the keyed tools pass with a fake catalog, and a test makes sure that no step output holds a key.
- [x] 4.3 Apply the connector settings: `enabled`, the endpoint override and the credential names. Done when: tests for a disabled connector on each agent and for the `web-search` endpoint override.
- [x] 4.4 Express the tool sets of today of each built-in agent as connectors. Remove `BASE_SANDBOX_TOOLS` entries that are now connectors (`resolveLibraryId`, `queryDocs`, `knowledgeTemplate`). Done when: a test compares the resolved tools of each built-in agent with its tool set before the change.
- [x] 4.5 Derive `liveSources` from the connectors of each executor. Done when: the planner catalog test names `gnomAD`, `HumanBase tissue networks`, `MyGene.info`, `ChEMBL` and `FAERS`.

## 5. MCP client

- [x] 5.1 Add `@modelcontextprotocol/client` and a connection pool for each server, with connect at first use, reconnect on a config change and close at shutdown. Done when: tests with an in-process stdio fixture server.
- [x] 5.2 Turn the tools of a server into loop tools: name normalization, result conversion, `isError`, the output cap. Done when: unit tests for a dotted name, a long name, a collision, a large result and an error result.
- [x] 5.3 Apply `approval` through the tool-approval gate, and `scriptable` through `run_script`. Report a gap for a scriptable server that needs approval. Done when: tests for each scenario of the `mcp-client` spec.
- [x] 5.4 Leave out the tools of a server that does not answer, and log a warning. Return a sign-in error for an expired token that cannot refresh. Done when: tests with a stopped fixture server and a fake `OAuthClientProvider`.

## 6. Executors, plans and runs

- [x] 6.1 Build the planner catalog and the plan `agent` validation from the resolved enabled executors when a plan is made. Remove the routing rules that name an agent from the planner prompt. Done when: a test plans with a custom executor in the catalog.
- [x] 6.2 Make the ad hoc `agent` field an id of the enabled executors, read when the chat turn starts. Done when: the ad hoc tests for the analyst default, the drug analyst, a custom executor and an unknown agent.
- [x] 6.3 Write the identity of each agent into the workflow input when the workflow starts it. Refuse a launch whose step names an agent that is not available. Done when: a recovery test keeps the prompt after an edit, and a launch test refuses a removed executor.
- [x] 6.4 Do a test of a recovery whose history calls a tool that the catalog no longer gives. Then make the recorded call replay its result and a new call return `unavailable`, with a placeholder tool if the test needs it. Done when: the recovery tests of the `agent-catalog` spec pass.
- [x] 6.5 Build each executor in `createSandboxAgent` from its identity and the current catalog: the role tools, the connector tools and the MCP tools. Done when: the composition tests of the `harness-sandbox-agents` and `per-agent-tool-allowlist` specs.
- [x] 6.6 Record the agent name and the prompt hash on the step row and on the `step_completed` event. Done when: a test makes sure that one prompt gives one hash and an edited prompt gives a new hash.

## 7. Integration

- [ ] 7.1 Run the `harness:verify` skill against a scratch consumer with a file-free catalog, a custom executor, a connector with a credential and a stdio MCP fixture. Done when: a chat turn and an ad hoc run on the custom executor complete.
- [x] 7.2 Run the full harness suite one time. Done when: the suite passes.
