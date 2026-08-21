# Delta: harness-sandbox-agents

## ADDED Requirements

### Requirement: The link_packages tool exists only when the seam is bound

The `ExtendAnalysisFarm` seam MUST ride as an optional field of the sandbox
agent deps. When the embedder binds the seam, the composition MUST add a
`link_packages` tool to the always-on substrate of every sandbox agent. No
`meta.tools` allowlist names the tool, because an allowlist entry would break
an embedder that binds no seam. Without the seam, the tool and its prompt
layer MUST NOT exist.

The tool links what the host staged, and it MUST NOT install, download, or
acquire anything. It MUST return one outcome per request: `linked`,
`present`, `absent` with `acquisitionPossible`, or `collision` with the two
store directories. A link MUST be live in the running sandbox, with no
restart. The tool description MUST state these facts.

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

### Requirement: The package-link prompt layer appends only with the seam

A static prompt layer for the link tool MUST append to the sandbox system
prompt only when the seam is bound. The layer MUST teach: call
`link_packages` after a failed import, pass the module name verbatim, a
refusal is a real answer, and a version collision is terminal. The layer is a
composition-time constant, thus the prompt stays byte-identical across the
steps of one composition.

#### Scenario: The layer follows the seam

- **GIVEN** two compositions, one with the seam bound and one without
- **WHEN** the two system prompts are compared
- **THEN** only the bound one carries the package-link layer, and each is stable across its own steps

## MODIFIED Requirements

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

The orient-core environment section MUST key its text on the declared
`toolchainSource`. With `"image"` it states that an acquisition is a host
action and directs the agent to report a missing package. Absent, it keeps
the legacy text, thus an old embedder keeps its cached prefix.

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

- **GIVEN** a composition with no `toolchainSource` and no bound seam
- **WHEN** the system prompt is compared with the prompt before this change
- **THEN** the orient-core section is unchanged
