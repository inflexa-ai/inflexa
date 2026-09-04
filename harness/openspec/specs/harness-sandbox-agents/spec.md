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

`createSandboxAgent` SHALL hand each agent exactly its `meta.tools` allowlist —
resolved against the central registry in `resolveSandboxTools` — plus the
always-on substrate, which is NOT declared in any meta: the mutate surface
(`execute_command`, `write_file`, `edit_file`), the read surface (`read_file`,
`list_files`, `file_stat`, `grep`, and `workspace_search` when an embedding
provider is wired), `inspect_data_profile`, the skill tools declared by
`meta.skills`, and `report_blocker` when a blocker cell is supplied.

`inspect_data_profile` is always-on because the persisted profile is the only
record of what the analysis's input dataset IS — no file on disk carries it (the
profiler's scratch tree is deleted on completion) — so an agent that cannot pull
it has no fallback but to re-derive organism, dimensions, and format from the raw
bytes. Under `readOnly` the `write_file`/`edit_file` pair SHALL be omitted while
`execute_command`, the read tools, and `inspect_data_profile` SHALL remain —
reading the profile is not a mutation.

An unknown `SandboxToolName` SHALL throw at composition time, not at the first LLM
call. Tools that need dependencies (`SandboxClient`, `WorkspaceFilesystem`,
`ChatProvider`, `Pool`) SHALL receive them through their factory closures at the
root — never via `ToolContext` or ambient state. `BASE_SANDBOX_TOOLS`
(`listAvailablePackages`, `listAvailableRefs`, `resolveLibraryId`, `queryDocs`,
`inspectRun`) SHALL be spread into each agent's `meta.tools` so planner metadata
and the resolved tool record stay in sync.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an agent whose meta declares `tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "searchGeoDatasets"]`
- **WHEN** the resolved tool list is inspected
- **THEN** it SHALL contain exactly those tools plus the always-on substrate
- **AND** it SHALL NOT contain `searchCompounds`, `searchFaers`, `searchToxcast`, or any tool outside the allowlist

#### Scenario: inspect_data_profile is wired without any meta declaring it

- **GIVEN** a sandbox agent whose `meta.tools` never names a data-profile tool
- **WHEN** its resolved tool list is inspected
- **THEN** it SHALL contain `inspect_data_profile`
- **AND** it SHALL still contain it when the agent is built `readOnly`

#### Scenario: Unknown tool name fails at composition time

- **GIVEN** an `AgentMeta` whose `tools` names a `SandboxToolName` with no registry entry
- **WHEN** `createSandboxAgent` builds the agent
- **THEN** it SHALL throw at composition time rather than at the first LLM call

#### Scenario: No SandboxClient on ToolContext

- **GIVEN** the harness `ToolContext` type
- **WHEN** a sandbox-agent tool's `execute` is typed against it
- **THEN** the `SandboxClient` SHALL NOT be reachable via `ToolContext` — it is captured by the tool's factory closure

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

The tool links what the host staged, and it MUST NOT install, download, or
acquire anything. It MUST return one outcome per request: `linked`,
`present`, `absent` with `acquisitionPossible`, `collision`, or
`unavailable`. A `collision` MUST carry the two store directories, and its
detail MUST name the packages that pull each side. An `unavailable` outcome
MUST carry the reason that the link pass cannot answer. It MUST NOT render
as an absence, because a false absence sends the agent after packages the
pool holds. A realization throw MUST read as `unavailable` with the thrown
reason, at each call site of the seam. A link MUST be live in the running
sandbox, with no restart. The tool description MUST state these facts.

The description MUST also state the remedy of a `collision` of one name in
two tracks: call the tool again for that package with `ecosystem` set. It
MUST state that a collision is terminal only after that call also refuses,
or when the collision is two versions of one distribution. The `ecosystem`
field exists for this call, and a description that calls each collision
terminal contradicts the field.

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

#### Scenario: The description names the ecosystem retry

- **WHEN** the description of `link_packages` is inspected
- **THEN** it directs the agent to call the tool again with `ecosystem` after a two-track `collision`, before it reports the package as unusable

### Requirement: The package-link prompt layer appends only with the seam

A static prompt layer for the link tool MUST append to the sandbox system
prompt only when the seam is bound. The layer MUST teach: call
`link_packages` after a failed import, and after `list_available_packages`
reports a package absent. It MUST teach: pass the module name verbatim, a
refusal is a real answer, and a version collision is terminal. It MUST
teach: after a `collision` of one name in two tracks, call the tool again
with `ecosystem`. It MUST teach: drop the package only when that call also
refuses. It MUST place the report of a missing package after an `absent` or
`unavailable` answer of the link tool. With the seam bound, the description
of `list_available_packages` MUST NOT state that only its own report is
importable. The reason: the link tool can extend the farm from the pool. The
layer is a composition-time constant, thus the prompt stays byte-identical
across the steps of one composition.

#### Scenario: The layer follows the seam

- **GIVEN** two compositions, one with the seam bound and one without
- **WHEN** the two system prompts are compared
- **THEN** only the bound one carries the package-link layer, and each is stable across its own steps

#### Scenario: An absent lookup routes through the link tool

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt and the description of `list_available_packages` are inspected
- **THEN** both direct the agent to call `link_packages` before it reports a package missing

#### Scenario: The layer teaches the ecosystem retry

- **GIVEN** a composition with the seam bound
- **WHEN** the system prompt is inspected
- **THEN** it directs the agent to call `link_packages` again with `ecosystem` after a two-track `collision`, and to drop the package only after that call refuses

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

A step agent SHALL get a terminal `report_blocker({ reason })` tool whenever a
blocker cell is supplied; there SHALL be no `submit`/`done` tool, because a
step's deliverable is its persisted files. Calling `report_blocker` SHALL record
`{ kind: "blocker", reason }` into the per-run holder the workflow body reads
after `runAgent`. `blocked` SHALL be a distinct terminal step status — separate
from `failed` and `completed` — carrying the reason to the
`cortex_step_executions.blocked_reason` column, a `data-step-blocked` run-event
part, and the step return. The parent scheduler SHALL treat a blocker exactly
like a step failure: only the blocked step's transitive dependents become
unreachable, while in-flight siblings and independent ready steps continue
(see the harness-durable-runtime capability). The harness SHALL NOT infer
failure from output/artifact counts: a legitimately-empty step (no files, no
blocker, clean finish) SHALL stay `completed`.

#### Scenario: Blocker yields a distinct blocked status

- **GIVEN** a step agent that calls `report_blocker({ reason })` and stops
- **WHEN** the workflow body reads the blocker holder after the loop
- **THEN** the step SHALL terminate with status `blocked`, persisting the reason to `blocked_reason` and emitting a `data-step-blocked` part
- **AND** in-flight siblings SHALL NOT be cancelled; only the blocked step's transitive dependents are never dispatched

#### Scenario: Empty step is not auto-failed

- **GIVEN** a step that writes no artifacts, calls no blocker, and ends cleanly
- **WHEN** the step terminates
- **THEN** its status SHALL be `completed` (with `artifactCount: 0`), not failed or blocked

### Requirement: Post-step interpretation runs as focused runAgent loops grounded by read_file

The post-step `generateFileMetadata` and `generateStepSummary` producers SHALL each run as a focused `runAgent` tool-loop on the harness `ChatProvider` over `passthroughStep`, taking the `Session` explicitly (billing is a compile-time obligation). They live at `harness/src/execution/artifact-metadata.ts` and `harness/src/execution/step-summary.ts`. Each loop SHALL be given a scoped `read_file` tool over the step's writable output tree so it grounds quantitative claims in persisted files rather than `execute_command` stdout, and SHALL be seeded with the step's in-memory transcript (per the message-store decision, workflow loops keep no `messages` table; reconstruction from `operation_outputs` is read-side only).

`generateFileMetadata` SHALL communicate exclusively through a `submit_file_metadata`
terminal tool that validates each entry's `path` against the known artifact set
(matched by path, never by array index); it SHALL be lossless — every input
artifact appears exactly once, a never-described file getting a deterministic
fallback description — and bounded by a small iteration budget (default 8).
`generateStepSummary` SHALL run a dedicated `step-summary-writer` sub-agent
(default iteration budget 12), return `{ stepId, agentId, markdown }` validated
by `StepSummarySchema` on non-empty final text, and return `undefined` (non-fatal)
on empty output or a loop throw — a summary failure SHALL NOT fail the step.

#### Scenario: Metadata describer is lossless

- **GIVEN** a step whose output artifacts the describer never fully covers within its budget
- **WHEN** `generateFileMetadata` returns
- **THEN** every input artifact SHALL appear exactly once, uncovered files receiving a deterministic fallback description

#### Scenario: Summary loop grounds claims via read_file

- **GIVEN** a `generateStepSummary` loop seeded with the step transcript and a scoped `read_file`
- **WHEN** it writes the summary
- **THEN** it SHALL be able to read persisted output files to ground claims rather than relying on command stdout

#### Scenario: Empty or failed summary is non-fatal

- **WHEN** the summary loop returns empty final text or throws
- **THEN** `generateStepSummary` SHALL return `undefined`
- **AND** the workflow body SHALL proceed without marking the step failed

