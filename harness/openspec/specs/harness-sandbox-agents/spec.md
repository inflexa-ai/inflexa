# harness-sandbox-agents Specification

## Purpose

Define the code-defined sandbox-agent layer: the directory under
`harness/src/agents/sandbox/`, the per-agent `AgentMeta`, the planner-facing
catalog, and per-agent tool resolution through a central registry. Each sandbox
agent is a plain `AgentDefinition` built by `createSandboxAgent(deps, meta, body,
opts?)` and run by the harness `runAgent` loop — there is no agent framework and
no request-time processor pipeline; the system prompt is a frozen static
composition (SOUL kernel + the agent's prompt body + sandbox standards).

**Honesty is structural, not inferred.** A staging incident produced
green runs in which agents computed results via ephemeral inline commands,
printed to stdout, ended on prose, and persisted nothing — and the post-step
summarizer laundered that stdout into authoritative-looking output. The tempting
fix (flag a step that "ran code but wrote no files") was rejected as a brittle
heuristic that mislabels legitimately-empty inspection steps. Instead a step
agent's deliverable is its persisted files; a clean end-of-turn after writing
them is the implicit success, and an agent that cannot fulfil its step calls a
terminal `report_blocker` tool. The harness records the real outcome and surfaces
genuine errors but runs no output-count "wrongness" heuristic. Because the
deliverables contract plus the blocker make inline-narrate-and-stop the wrong
move, the post-step summarizers keep drawing on the agent's transcript and also
gain a scoped `read_file` to ground every claim in the actual persisted outputs.

## Requirements

### Requirement: Code-defined sandbox agents in a directory structure

The harness SHALL define every sandbox agent under `harness/src/agents/sandbox/`.
The directory SHALL contain `shared.ts` (the composition root: tool registry,
`BASE_SANDBOX_TOOLS`, `createSandboxAgent`, `resolveSandboxTools`), `types.ts`
(the `AgentMeta` interface, the `SandboxToolName` union, and
`SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS`), `index.ts` (the `SANDBOX_AGENT_META`
record and the `createSandboxAgents(deps)` builder), and one file per agent. The
agent set SHALL cover the data-profiler, the omics specialists,
scientific-executor, cheminformatics, translational-safety,
pkpd-clinical-response, immune-profiling, and drug-repurposing. It SHALL NOT
contain a special ephemeral executor. Each `AgentDefinition` SHALL carry the
five fields `runAgent` consumes: `id`, `systemPrompt`, `model`, `tools`, and
`maxIterations`.

#### Scenario: Catalog covers every agent

- **WHEN** the keys of `SANDBOX_AGENT_META` are compared to `createSandboxAgents(deps)`
- **THEN** every agent id SHALL map to an `AgentMeta` entry
- **AND** every id SHALL resolve to an `AgentDefinition` built by `createSandboxAgent(deps, meta, body)`

#### Scenario: Each definition is fully populated

- **WHEN** any sandbox `AgentDefinition` is inspected
- **THEN** its `id`, `systemPrompt`, `model`, `tools`, and `maxIterations` SHALL all be populated

#### Scenario: Ephemeral executor is absent

- **WHEN** the sandbox-agent source files and catalog are inspected
- **THEN** no `ephemeral-executor` definition, prompt, metadata entry, or factory entry exists

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

### Requirement: AgentMeta declares per-agent planner metadata and tool allowlist

The harness SHALL export an `AgentMeta` entry per sandbox agent with: `id`
(string), `capabilities` (string array), `suitableFor` (string array), `skills`
(skill directory names), `tools` (`SandboxToolName[]`), an optional
`defaultMaxSteps` (number), and an optional `plannable` (boolean, defaults true).
The agent's runaway cap SHALL be `meta.defaultMaxSteps ??
SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS` (50).

#### Scenario: Every meta has a non-empty tools field

- **WHEN** all entries in `SANDBOX_AGENT_META` are inspected
- **THEN** every entry SHALL have a non-empty `tools` array of `SandboxToolName` values

#### Scenario: defaultMaxSteps overrides the runaway cap

- **GIVEN** an agent whose meta sets `defaultMaxSteps: 35`
- **WHEN** its `AgentDefinition` is built
- **THEN** `maxIterations` SHALL be `35`
- **AND** an agent with no `defaultMaxSteps` SHALL use `SANDBOX_AGENT_DEFAULT_MAX_ITERATIONS` (50)

### Requirement: The link_packages tool exists only when the seam is bound

The `ExtendAnalysisFarm` seam MUST ride as an optional field of the sandbox
agent deps. When the embedder binds the seam, the composition MUST add a
`link_packages` tool to the always-on substrate of every sandbox agent. No
`meta.tools` allowlist names the tool, because an allowlist entry would break
an embedder that binds no seam. Without the seam, the tool and its prompt
layer MUST NOT exist.

The tool MUST take `packages` as an array of strings in the one grammar
of the `package-identity` capability, and it MUST parse each with
`parseQuery`. An entry that does not parse MUST refuse the call with the
parse issue and the entry, before any link. The tool holds no `ecosystem`
field, because the prefix carries the track, and one agent learns one
grammar.

The tool links what the host staged, and it MUST NOT install, download, or
acquire anything. It MUST return one outcome per query: `linked`,
`present`, `absent` with `acquisitionPossible`, `collision`, or
`unavailable`. An outcome MUST echo the spelling of its query. A
`collision` MUST carry the two store directories. Its detail MUST name
the packages that pull each side. For one spelling in two tracks, the
detail MUST name the two prefixed forms instead. An `unavailable` outcome MUST
carry the reason that the link pass cannot answer. It MUST NOT render as
an absence, because a false absence sends the agent after packages the
pool holds. A realization throw MUST read as `unavailable` with the thrown
reason, at each call site of the seam. A link MUST be live in the running
sandbox, with no restart. The tool description MUST state these facts.

The description MUST also state the remedy of a `collision` of one
spelling in two tracks: call the tool again with the prefixed form,
`python:<name>` or `r:<name>`. It MUST state that a collision is terminal
only after that call also refuses, or when the collision is two versions
of one distribution.

#### Scenario: A bound seam adds the tool

- **GIVEN** sandbox agent deps with `extendAnalysisFarm` bound
- **WHEN** the resolved tool list of any sandbox agent is inspected
- **THEN** it contains `link_packages`, and no `meta.tools` entry names it

#### Scenario: An unbound seam means no tool

- **GIVEN** sandbox agent deps without the seam
- **WHEN** the resolved tool list is inspected
- **THEN** `link_packages` is absent, and the composition does not throw

#### Scenario: A refusal tells the agent whether an acquisition can help

- **GIVEN** a request for a package that the pool does not hold
- **WHEN** `link_packages` returns
- **THEN** the outcome is `absent`, and `acquisitionPossible` states whether the host can acquire that ecosystem

#### Scenario: A link pass that cannot answer says why

- **GIVEN** a store whose dependency graph the realization cannot read
- **WHEN** `link_packages` returns
- **THEN** each outcome is `unavailable` with the graph reason, and no outcome is `absent`

#### Scenario: A realization throw reads as unavailable

- **GIVEN** a realization that throws at the link call
- **WHEN** `link_packages` returns
- **THEN** each outcome is `unavailable` with the thrown reason, and the loop sees no raw error

#### Scenario: A prefixed entry reaches the seam as a qualified query

- **WHEN** the agent calls `link_packages` with `["r:Seurat"]`
- **THEN** the seam receives one query with the spelling `Seurat` and the track `r`

#### Scenario: An entry that does not parse refuses the call

- **WHEN** the agent calls `link_packages` with `["bioc:fgsea"]`
- **THEN** the tool refuses with an issue that names the entry and the two permitted prefixes, and no link lands

#### Scenario: The description names the prefixed retry

- **WHEN** the description of `link_packages` is inspected
- **THEN** it directs the agent to call the tool again with `python:<name>` or `r:<name>` after a two-track `collision`

### Requirement: The package-link prompt layer appends only with the seam

A static prompt layer for the link tool MUST append to the sandbox system
prompt only when the seam is bound. The layer MUST teach: call
`link_packages` after a failed import, and after `list_available_packages`
reports a package absent. It MUST teach: pass the module name verbatim, a
refusal is a real answer, and a version collision is terminal. It MUST
teach the one grammar: after a `collision` of one spelling in two tracks,
call the tool again with `python:<name>` or `r:<name>`. It MUST teach:
drop the package only when that call also refuses. It MUST place the
report of a missing package after an `absent` or `unavailable` answer of
the link tool. With the seam bound, the description of
`list_available_packages` MUST NOT state that only its own report is
importable. The reason: the link tool can extend the farm from the pool.
The layer is a composition-time constant, thus the prompt stays
byte-identical across the steps of one composition.

#### Scenario: The layer follows the seam

- **GIVEN** two compositions, one with the seam bound and one without
- **WHEN** the two system prompts are compared
- **THEN** only the bound one carries the package-link layer, and each is stable across its own steps

#### Scenario: An absent lookup routes through the link tool

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt and the description of `list_available_packages` are inspected
- **THEN** both direct the agent to call `link_packages` before it reports a package missing

#### Scenario: The layer teaches the prefixed retry

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt is inspected
- **THEN** it directs the agent to retry `link_packages` with `python:<name>` or `r:<name>` after a two-track `collision`, and to drop the package only after that refusal

### Requirement: Sandbox agent system prompt is a pure function of the agent type

Each sandbox `AgentDefinition.systemPrompt` MUST be assembled at construction
time by `composeSystemPrompt` (with the conversational style disabled). The
composition concatenates the per-agent prompt body
(`harness/src/prompts/sandbox/<agent>.ts`), `sandboxOrientCorePrompt`, the
package-link layer when the seam is bound, and
`sandboxAnalysisStepStandardsPrompt` (the last omitted under
`appendAnalysisStepStandards: false`). The composed string MUST be a pure
function of the composition-time constants: the agent type, the bound seam,
and the declared `toolchainSource`. Nothing from `SandboxStepCoords` MUST
reach it: no path, no `analysisId`/`runId`/`stepId`, and no placeholder for
one. Two steps of one run — and two runs of one analysis — send a
byte-identical prefix.

This is a **prompt-cache** invariant, not a style rule. The cache keys on an
exact prefix. A single interpolated id or path makes every step's system
string unique, so each step pays a full cache write and reads nothing back.
The per-step values belong in the step's seed
(`harness/src/prompts/briefing.ts`), which names the working directory, the
analysis root, the dataset, and each dependency's output. The prompt MUST be
a frozen string by the time `runAgent` sees it — there is no request-time
processor pipeline.

The orient-core environment section MUST key its text on the
`toolchainSource` of the sandbox client, and on no field of the agent deps.
With `"image"` it states that an acquisition is a host action and directs
the agent to report a missing package. With `"store"` it keeps the legacy
text, thus an embedder that declares no toolchain keeps its cached prefix.

#### Scenario: System prompt is a single composed string

- **GIVEN** any sandbox `AgentDefinition`
- **WHEN** `definition.systemPrompt` is read
- **THEN** it is a `string` containing the agent prompt body, `sandboxOrientCorePrompt`, and `sandboxAnalysisStepStandardsPrompt`

#### Scenario: The prompt is byte-identical across steps and leaks no per-step value

- **GIVEN** the same sandbox agent built twice with different `SandboxStepCoords` (different run, step, and write prefix)
- **WHEN** the two `systemPrompt` strings are compared
- **THEN** they are byte-identical
- **AND** neither contains a step path, a `runId`/`stepId`/`analysisId`, or an unsubstituted `{{…}}` placeholder

#### Scenario: The legacy embedder keeps its prefix

- **GIVEN** a sandbox client composed with no `toolchainSource` and no bound seam
- **WHEN** the system prompt is compared with the prompt of the legacy embedder
- **THEN** the orient-core section is unchanged

### Requirement: Planner catalog derives from the sandbox-agent meta

`SANDBOX_AGENT_META` (`harness/src/agents/sandbox/index.ts`) SHALL be the source
of truth from which the planner catalog (`harness/src/agents/sandbox-catalog.ts`)
derives `PLANNABLE_AGENT_CATALOG` by projecting `{ id, capabilities, suitableFor }`
and filtering on `plannable !== false`. `generatePlan` SHALL consume the rendered
markdown via `formatAgentCatalog()`. Non-plannable agents (`data-profiler`,
`scientific-executor`, `ephemeral-executor`) SHALL be excluded from the catalog.

#### Scenario: Planner catalog excludes non-plannable agents

- **WHEN** `formatAgentCatalog()` renders `PLANNABLE_AGENT_CATALOG`
- **THEN** it SHALL list each plannable agent with its `capabilities` and `suitableFor`
- **AND** `data-profiler`, `scientific-executor`, and `ephemeral-executor` SHALL NOT appear

### Requirement: Step agents declare inability via report_blocker, not output inference

A step agent MUST get a terminal `report_blocker({ reason })` tool when a blocker cell is supplied. The step agent MUST NOT get a `submit` or `done` tool for its task, because the deliverable of a step is its persisted files. A clean end of the turn after the agent writes the files is the implicit success. The `submit_file_metadata` output tool does not end a task: the task masks it, and only the file-metadata continuation lets it run.

A call of `report_blocker` MUST record `{ kind: "blocker", reason }` into the cell of the run. After `runAgent`, the workflow body MUST read the blocker from the transcript: the reason of the first `report_blocker` call whose result is ok. The cell is the fallback. A durable replay returns the cached result of the tool step and runs no `execute`, thus the cell of a replayed body stays empty. The transcript holds the call and its result on each replay.

`blocked` MUST be a distinct terminal step status, separate from `failed` and `completed`. It carries the reason to the `cortex_step_executions.blocked_reason` column, to a `data-step-blocked` run-event part, and to the step return.

The parent scheduler MUST treat a blocker exactly like a step failure: only the transitive dependents of the blocked step become unreachable. In-flight siblings and independent ready steps continue (refer to the harness-durable-runtime capability). The harness MUST NOT infer a failure from output or artifact counts for a step that finished on its own initiative. A step that is empty for a valid reason (no files, no blocker, a clean finish before the iteration cap) MUST stay `completed`.

The exception is narrow. If the loop hits its iteration cap, the artifact
manifest is empty, and no blocker exists, the step MUST terminate `blocked`.
The reason MUST be deterministic, and it MUST name the cap and the empty
manifest. A capped-out step with artifacts stays `completed`, because partial
output is real output.

#### Scenario: Blocker yields a distinct blocked status

- **GIVEN** a step agent that calls `report_blocker({ reason })` and stops
- **WHEN** the workflow body reads the blocker after the loop
- **THEN** the step MUST end with the status `blocked`, persist the reason to `blocked_reason`, and emit a `data-step-blocked` part
- **AND** the in-flight siblings MUST continue, and only the transitive dependents of the blocked step are never dispatched

#### Scenario: A replayed blocker keeps the blocked status

- **GIVEN** a durable step whose agent called `report_blocker`, and a recovery that replays the step
- **WHEN** the replay returns the cached result of the tool step, and the cell stays empty
- **THEN** the body reads the blocker from the transcript, and the step ends `blocked` with the same reason

#### Scenario: Empty step is not auto-failed

- **GIVEN** a step that writes no artifacts, calls no blocker, and ends cleanly before its iteration cap
- **WHEN** the step ends
- **THEN** its status MUST be `completed` (with `artifactCount: 0`), not failed or blocked

#### Scenario: Capped-out step with no deliverables is blocked

- **GIVEN** a step whose loop hits the iteration cap, with an empty artifact manifest and no blocker
- **WHEN** the workflow body reads the manifest after the loop
- **THEN** the step MUST terminate `blocked`, with a deterministic reason in `blocked_reason` and a `data-step-blocked` part
- **AND** the transitive dependents of the step are never dispatched

#### Scenario: Capped-out step with artifacts stays completed

- **GIVEN** a step whose loop hits the iteration cap, with a non-empty artifact manifest
- **WHEN** the step terminates
- **THEN** its status MUST be `completed`, with `hitMaxSteps` persisted

#### Scenario: The task cannot use the output tool

- **GIVEN** a step agent that calls `submit_file_metadata` during its task
- **WHEN** the loop dispatches the call
- **THEN** the call gets the error result of the mask, and the file-metadata cell records no description

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

#### Scenario: Summary loop grounds claims via read_file

- **GIVEN** a summary continuation over the transcript of the step, whose mask lets `read_file` run
- **WHEN** the continuation writes the summary
- **THEN** it can read the persisted output files to ground its claims, and it does not depend on the stdout of a command

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
