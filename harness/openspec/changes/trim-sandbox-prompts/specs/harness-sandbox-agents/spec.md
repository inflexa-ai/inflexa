# Spec Delta

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

An unknown `SandboxToolName` MUST throw at composition time, not at the first LLM call. A tool with a dependency (`SandboxClient`, `WorkspaceFilesystem`, `ChatProvider`, `Pool`, the tool output store) MUST get it through its factory closure at the root, never through `ToolContext` or ambient state. Each agent MUST spread `BASE_SANDBOX_TOOLS` into its `meta.tools`. Thus the planner metadata and the resolved tool record stay in sync.

A sandbox agent MUST NOT get `inspect_run`. A step runs inside its own run, and `inspect_run` gives the step paths only for a finished run. The briefing names the path of each completed dependency instead.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an agent whose meta declares `tools: [...BASE_SANDBOX_TOOLS, "pubmed", "searchGeoDatasets"]`
- **WHEN** the resolved tool list is inspected
- **THEN** it MUST contain exactly those tools plus the always-on substrate
- **AND** it MUST NOT contain `chembl`, `search_faers`, `comptox`, or any tool outside the allowlist

#### Scenario: No sandbox agent inspects a run

- **WHEN** the resolved tool list of any sandbox agent is inspected
- **THEN** it does not contain `inspect_run`

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

### Requirement: The link_packages tool exists only when the seam is bound

The `ExtendAnalysisFarm` seam MUST ride as an optional field of the sandbox
agent deps. When the embedder binds the seam, the composition MUST add a
`link_packages` tool to the always-on substrate of every sandbox agent. No
`meta.tools` allowlist names the tool, because an allowlist entry would break
an embedder that binds no seam. Without the seam, the tool MUST NOT exist.
The seam MUST NOT change the system prompt. Thus a bound seam does not split
the prompt cache.

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
sandbox, with no restart.

With the seam bound, the description of `list_available_packages` MUST NOT
state that only its own report is importable. The reason: the link tool can
extend the farm from the pool.

#### Scenario: A bound seam adds the tool

- **GIVEN** sandbox agent deps with `extendAnalysisFarm` bound
- **WHEN** the resolved tool list of any sandbox agent is inspected
- **THEN** it contains `link_packages`, and no `meta.tools` entry names it

#### Scenario: An unbound seam means no tool

- **GIVEN** sandbox agent deps without the seam
- **WHEN** the resolved tool list is inspected
- **THEN** `link_packages` is absent, and the composition does not throw

#### Scenario: The seam does not change the system prompt

- **GIVEN** two compositions of one agent, one with the seam bound and one without
- **WHEN** the two system prompts are compared
- **THEN** they are byte-identical

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

### Requirement: Sandbox agent system prompt is a pure function of the agent type

Each sandbox `AgentDefinition.systemPrompt` MUST be assembled at construction
time by `composeSystemPrompt` (with the conversational style disabled). The
composition concatenates the per-agent prompt body
(`harness/src/prompts/sandbox/<agent>.ts`), the orient core, and
`sandboxAnalysisStepStandardsPrompt` (the last omitted under
`appendAnalysisStepStandards: false`). The composed string MUST be a pure
function of the agent type and the declared `toolchainSource`. Nothing from
`SandboxStepCoords` MUST reach it: no path, no `analysisId`/`runId`/`stepId`,
and no placeholder for one. Two steps of one run — and two runs of one
analysis — send a byte-identical prefix.

This is a **prompt-cache** invariant, not a style rule. The cache keys on an
exact prefix. A single interpolated id or path makes every step's system
string unique, so each step pays a full cache write and reads nothing back.
The per-step values belong in the step's seed
(`harness/src/prompts/briefing.ts`), which names the working directory, the
analysis root, the dataset, and each dependency's output. The prompt MUST be
a frozen string by the time `runLoop` sees it — there is no request-time
processor pipeline.

The orient core MUST key its text on the `toolchainSource` of the sandbox
client, and on no field of the agent deps. With `"store"`, it is
`sandboxOrientCorePrompt` unchanged.

#### Scenario: System prompt is a single composed string

- **GIVEN** any sandbox `AgentDefinition`
- **WHEN** `definition.systemPrompt` is read
- **THEN** it is a `string` that holds the agent prompt body, the orient core, and `sandboxAnalysisStepStandardsPrompt` unless the agent opts out

#### Scenario: The prompt is byte-identical across steps and leaks no per-step value

- **GIVEN** the same sandbox agent built twice with different `SandboxStepCoords` (different run, step, and write prefix)
- **WHEN** the two `systemPrompt` strings are compared
- **THEN** they are byte-identical
- **AND** neither contains a step path, a `runId`/`stepId`/`analysisId`, or an unsubstituted `{{…}}` placeholder

#### Scenario: The legacy embedder keeps its prefix

- **GIVEN** a sandbox client composed with no `toolchainSource`
- **WHEN** the system prompt is composed
- **THEN** it contains `sandboxOrientCorePrompt` unchanged

## REMOVED Requirements

### Requirement: The package-link prompt layer appends only with the seam

**Reason**: The layer repeated the descriptions of `link_packages` and `list_available_packages`, and one sentence of it was false: it told the agent to report a package as missing after `unavailable`, but `unavailable` says nothing about the presence of a package. The layer is deleted, and the requirement pinned its wording.

**Migration**: None. The two tool descriptions carry each rule of a link. The requirement "The link_packages tool exists only when the seam is bound" keeps the code contract: the outcomes, the seam-dependent listing description, and a system prompt that the seam does not change.
