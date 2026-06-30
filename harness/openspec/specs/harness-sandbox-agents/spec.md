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
agent set SHALL cover the data-profiler, the omics specialists, the executors,
cheminformatics, translational-safety, pkpd-clinical-response, immune-profiling,
and drug-repurposing. Each `AgentDefinition` SHALL carry the four fields
`runAgent` consumes: `id`, `systemPrompt`, `model`, `tools`, and `maxIterations`.

#### Scenario: Catalog covers every agent

- **WHEN** the keys of `SANDBOX_AGENT_META` are compared to `createSandboxAgents(deps)`
- **THEN** every agent id SHALL map to an `AgentMeta` entry
- **AND** every id SHALL resolve to an `AgentDefinition` built by `createSandboxAgent(deps, meta, body)`

#### Scenario: Each definition is fully populated

- **WHEN** any sandbox `AgentDefinition` is inspected
- **THEN** its `id`, `systemPrompt`, `model`, `tools`, and `maxIterations` SHALL all be populated

### Requirement: Composition root resolves each agent's tools from a central registry

`createSandboxAgent` SHALL hand each agent exactly its `meta.tools` allowlist —
resolved against the central registry in `resolveSandboxTools` — plus the
always-on workspace substrate: the mutate surface (`execute_command`,
`write_file`, `edit_file`), the read surface (`read_file`, `list_files`,
`file_stat`, `grep`, and `workspace_search` when an embedding provider is wired),
the skill tools declared by `meta.skills`, and `report_blocker` when a blocker
cell is supplied. An unknown `SandboxToolName` SHALL throw at composition time,
not at the first LLM call. Tools that need dependencies (`SandboxClient`,
`WorkspaceFilesystem`, `ChatProvider`, `Pool`) SHALL receive them through their
factory closures at the root — never via `ToolContext` or ambient state.
`BASE_SANDBOX_TOOLS` (`listAvailablePackages`, `listAvailableRefs`,
`resolveLibraryId`, `queryDocs`, `inspectRun`) SHALL be spread into each agent's
`meta.tools` so planner metadata and the resolved tool record stay in sync.

#### Scenario: Compute-pipeline agent receives only its allowlisted tools

- **GIVEN** an agent whose meta declares `tools: [...BASE_SANDBOX_TOOLS, "searchPubMed", "getArticleDetails", "searchGeoDatasets"]`
- **WHEN** the resolved tool list is inspected
- **THEN** it SHALL contain exactly those tools plus the always-on workspace substrate
- **AND** it SHALL NOT contain `searchCompounds`, `searchFaers`, `searchToxcast`, or any tool outside the allowlist

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

### Requirement: Sandbox agent system prompt is static composition

Each sandbox `AgentDefinition.systemPrompt` SHALL be assembled at construction
time by `composeSystemPrompt` (with the conversational style disabled) over the
deterministic concatenation of the per-agent prompt body
(`harness/src/prompts/sandbox/<agent>.ts`), `sandboxOrientCorePrompt`, and
`sandboxAnalysisStepStandardsPrompt`. The `{{WORKING_DIR}}` and
`{{ANALYSIS_ROOT}}` placeholders SHALL be substituted with the concrete
in-sandbox paths the agent sees this step (frame-aware path resolution). The
prompt SHALL be a frozen string by the time `runAgent` sees it — there is no
request-time processor pipeline.

#### Scenario: System prompt is a single composed string

- **GIVEN** any sandbox `AgentDefinition`
- **WHEN** `definition.systemPrompt` is read
- **THEN** it SHALL be a `string` containing the agent prompt body, `sandboxOrientCorePrompt`, and `sandboxAnalysisStepStandardsPrompt`
- **AND** the `{{WORKING_DIR}}`/`{{ANALYSIS_ROOT}}` placeholders SHALL be replaced with concrete paths

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
part, and the step return. A step blocker SHALL fail-fast, cancelling in-flight
siblings exactly like a failure. The harness SHALL NOT infer failure from
output/artifact counts: a legitimately-empty step (no files, no blocker, clean
finish) SHALL stay `completed`.

#### Scenario: Blocker yields a distinct blocked status

- **GIVEN** a step agent that calls `report_blocker({ reason })` and stops
- **WHEN** the workflow body reads the blocker holder after the loop
- **THEN** the step SHALL terminate with status `blocked`, persisting the reason to `blocked_reason` and emitting a `data-step-blocked` part
- **AND** the step SHALL fail-fast, cancelling in-flight siblings

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
