## MODIFIED Requirements

### Requirement: Composition root resolves each agent's tools from a central registry

`createSandboxAgent` MUST give each agent exactly its `meta.tools` allowlist, resolved against the central registry in `resolveSandboxTools`, plus the always-on substrate. No meta declares the substrate. The substrate is these tools:

- the mutate surface: `execute_command`, `write_file`, and `edit_file`
- the read surface: `read_file`, `list_files`, `file_stat`, `grep`, and `workspace_search` when an embedding provider is wired
- `read_tool_output` when a tool output store is supplied, after the workspace tools
- `inspect_data_profile`
- the skill tools that `meta.skills` declares
- `report_blocker` when a blocker cell is supplied
- `submit_file_metadata` when a file-metadata cell is supplied

`inspect_data_profile` is always on, because the persisted profile is the only record of what the input dataset of the analysis is. No file on disk carries it, because the profiler deletes its scratch tree on completion. Thus an agent that cannot read the profile must derive the organism, the dimensions, and the format again from the raw bytes. Under `readOnly`, the agent MUST NOT get `write_file` and `edit_file`. It MUST keep `execute_command`, the read tools, and `inspect_data_profile`, because a read of the profile is not a mutation.

`read_tool_output` reads the kept text of a tool result that the loop cut (refer to the harness-tools capability). `SandboxAgentDeps.toolOutputStore` supplies the store, and the step body gives the same store to the loop of the agent. Under `readOnly`, the agent MUST keep `read_tool_output`, because a read of a kept text is not a mutation.

An unknown `SandboxToolName` MUST throw at composition time, not at the first LLM call. A tool with a dependency (`SandboxClient`, `WorkspaceFilesystem`, `ChatProvider`, `Pool`, the tool output store) MUST get it through its factory closure at the root, never through `ToolContext` or ambient state. Each agent MUST spread `BASE_SANDBOX_TOOLS` (`listAvailablePackages`, `listAvailableRefs`, `resolveLibraryId`, `queryDocs`, `inspectRun`) into its `meta.tools`. Thus the planner metadata and the resolved tool record stay in sync.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an agent whose meta declares `tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "searchGeoDatasets"]`
- **WHEN** the resolved tool list is inspected
- **THEN** it MUST contain exactly those tools plus the always-on substrate
- **AND** it MUST NOT contain `searchCompounds`, `searchFaers`, `searchToxcast`, or any tool outside the allowlist

#### Scenario: inspect_data_profile is wired without any meta declaring it

- **GIVEN** a sandbox agent whose `meta.tools` never names a data-profile tool
- **WHEN** its resolved tool list is inspected
- **THEN** it MUST contain `inspect_data_profile`
- **AND** it MUST still contain it when the agent is built `readOnly`

#### Scenario: Unknown tool name fails at composition time

- **GIVEN** an `AgentMeta` whose `tools` names a `SandboxToolName` with no registry entry
- **WHEN** `createSandboxAgent` builds the agent
- **THEN** it MUST throw at composition time, not at the first LLM call

#### Scenario: No SandboxClient on ToolContext

- **GIVEN** the harness `ToolContext` type
- **WHEN** the `execute` of a sandbox-agent tool is typed against it
- **THEN** the `SandboxClient` MUST NOT be reachable through `ToolContext`, because the factory closure of the tool captures it

#### Scenario: A file-metadata cell adds the output tool

- **GIVEN** a sandbox agent built with a file-metadata cell
- **WHEN** its resolved tool list is inspected
- **THEN** it contains `submit_file_metadata`
- **AND** an agent built with no cell, for example the data profiler, does not contain it

#### Scenario: A tool output store adds the read tool

- **GIVEN** a sandbox agent built with a tool output store
- **WHEN** its resolved tool list is inspected
- **THEN** it contains `read_tool_output` directly after the workspace tools, also when the agent is built `readOnly`
- **AND** the same deps with no store give the same tool list without `read_tool_output`

### Requirement: Post-step interpretation continues the conversation of the step agent

The post-step producers `generateFileMetadata` and `generateStepSummary` MUST each run as a continuation of the conversation of the step agent (refer to the harness-agent-loop capability). Each continuation MUST use the agent definition, the transcript, the provider, and the session of the task. Thus each request extends the prefix that the task cached, and each thinking block of the task stays valid. The producers live at `harness/src/execution/artifact-metadata.ts` and `harness/src/execution/step-summary.ts`.

Workflow loops keep no `messages` table. The workflow body holds the transcript in memory, and a reconstruction from `operation_outputs` is read-side only.

Both masks MUST let the read-only tools `read_file`, `grep`, and `read_tool_output` run. Thus the summary can back each number with a persisted file, and the describer can read a file when its path is not enough. A `read_file` result that is longer than the cap of the loop comes back as an excerpt, and `read_tool_output` reads the rest. A mask does not change the prefix of a request.

Each continuation MUST run with the tool output store of the task. Thus the loop of a continuation keeps the text of a long result, and a reference of the task stays readable.

The file-metadata continuation MUST use the accounting agent id `file-metadata-describer` and a cap of 8 requests. Its mask MUST let `submit_file_metadata`, `read_file`, `grep`, and `read_tool_output` run. Its request is the text of the describer instructions and the list of the files.

`submit_file_metadata` MUST validate the `path` of each entry against the known artifact set. It MUST match a description to a file by path, never by array index. The result MUST be lossless: each input artifact appears exactly once, and a file with no description gets a deterministic fallback description.

The step-summary continuation MUST run after the file-metadata exchange, over the transcript and the messages of that exchange. Thus it reads the cache that the exchange wrote. It MUST use the accounting agent id `step-summary-writer` and a cap of 12 requests. Its mask MUST let only `read_file`, `grep`, and `read_tool_output` run. When the file-metadata stage gives no exchange, the summary MUST continue the transcript directly.

The summary continuation MUST return `{ stepId, agentId, markdown }`, validated by `StepSummarySchema`, on a final text that is not empty. On an empty text or a throw, it MUST return `undefined`, and a summary failure MUST NOT fail the step.

Each producer MUST stay inside its `DBOS.runStep` wrapper. The file-metadata step MUST return the messages of its exchange with its entries. Thus a replay gives the summary the same prefix. A step agent can lack `submit_file_metadata`. Then the body MUST log one warn and give the fallback description to each file, with no model call.

#### Scenario: The metadata continuation extends the prefix of the task

- **GIVEN** a step whose task ended on a text reply
- **WHEN** the file-metadata continuation sends its first request
- **THEN** the request carries the system prompt and the tools of the step agent, and its messages start with the transcript of the task, byte-identical

#### Scenario: Metadata describer is lossless

- **GIVEN** a step whose output artifacts the continuation never fully covers within its cap
- **WHEN** `generateFileMetadata` returns
- **THEN** each input artifact MUST appear exactly once, and each file with no description gets a deterministic fallback description

#### Scenario: The summary continues after the metadata exchange

- **GIVEN** a step whose file-metadata continuation recorded descriptions
- **WHEN** the summary continuation sends its request
- **THEN** its messages start with the transcript of the task and the messages of the metadata exchange, byte-identical

#### Scenario: The describer reads a file before it submits

- **GIVEN** a file-metadata continuation whose model reads a file with `read_file`, then calls `submit_file_metadata`
- **WHEN** the continuation returns
- **THEN** the read ran, and the description of that file is in the result

#### Scenario: The summary continuation runs only the read tools

- **GIVEN** a summary continuation whose model calls `read_file` and `write_file` in one reply
- **WHEN** the loop dispatches the calls
- **THEN** `read_file` runs, and `write_file` gets the error result of the mask

#### Scenario: A continuation reads the rest of a long read

- **GIVEN** a summary continuation whose `read_file` result has 90,000 characters
- **WHEN** the model calls `read_tool_output` with the reference of the excerpt
- **THEN** the call runs, and it gives a page of the kept text

#### Scenario: Empty or failed summary is non-fatal

- **WHEN** the summary continuation returns an empty final text or throws
- **THEN** `generateStepSummary` MUST return `undefined`
- **AND** the workflow body MUST continue, and the step does not fail

#### Scenario: An agent with no output tool falls back

- **GIVEN** an embedder whose `buildAgent` does not give the file-metadata cell to the agent
- **WHEN** the post-step pipeline runs
- **THEN** the body logs one warn, and each file gets the deterministic fallback description with no model call
