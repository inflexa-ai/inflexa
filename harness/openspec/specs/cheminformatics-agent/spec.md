# cheminformatics-agent Specification

## Purpose

Define the `cheminformatics-agent` sandbox agent — a generalist molecular-analysis
agent covering SAR triage, compound-library characterization, QSAR modeling,
ADMET prediction, chemical-space visualization, target-engagement assessment,
drug-perturbation connectivity scoring, and selectivity profiling. Like every
sandbox agent it is a thin composition: `createSandboxAgent` binds a static
prompt, the always-on workspace and skill tools, and the bio/chem tools named in
its `meta.tools` allowlist. Its method know-how is **not** duplicated in the
prompt or this spec — it lives in the `cheminformatics` skill pack's `SKILL.md`
decision tree (see the cheminformatics-skill spec), which the agent reaches via
`skill_search` / `skill_read`. The agent's metadata follows the harness
`AgentMeta` shape exactly: there is no `languages` field, and ChEMBL/PubChem
access is granted through `meta.tools`, not baked into the shared base tool set.

## Requirements

### Requirement: Agent definition and composition

The system SHALL define the cheminformatics agent in
`agents/sandbox/cheminformatics-agent.ts`, constructed by
`createSandboxAgent(deps, meta, cheminformaticsAgentPrompt)` from
`agents/sandbox/shared.ts`. The resolved `AgentDefinition` SHALL carry
`id: "cheminformatics-agent"` and the tools named in `meta.tools`, plus the
always-on workspace read/mutate surface and the `skill_search` / `skill_read`
tools (the latter wired from `meta.skills`).

#### Scenario: Factory produces a valid agent

- **WHEN** the agent is constructed via `createSandboxAgent(deps, meta, cheminformaticsAgentPrompt)`
- **THEN** the returned `AgentDefinition` has `id: "cheminformatics-agent"`
- **AND** its tool set resolves every name in `meta.tools`
- **AND** the workspace tools and skill tools are wired regardless of `meta.tools`

### Requirement: Base tools plus ChEMBL/PubChem via meta.tools

The agent's `meta.tools` SHALL spread `BASE_SANDBOX_TOOLS` — which is exactly
`["listAvailablePackages", "listAvailableRefs", "resolveLibraryId", "queryDocs",
"inspectRun"]` — and SHALL add its compound-data tools explicitly. The ChEMBL
tools (`searchCompounds`, `getBioactivity`, `searchTargets`, `getMechanism`,
`getDrugInfo`, `searchDgidb`) and PubChem tools (`searchPubchemCompound`,
`getPubchemCrossRefs`, `getPubchemAssays`) SHALL be granted through `meta.tools`,
NOT through `BASE_SANDBOX_TOOLS`.

#### Scenario: Base set excludes compound-data tools

- **WHEN** `BASE_SANDBOX_TOOLS` is inspected
- **THEN** it is exactly the five introspection/docs/inspection tools
- **AND** it contains no ChEMBL or PubChem tool

#### Scenario: ChEMBL and PubChem are present via the allowlist

- **WHEN** the cheminformatics `meta.tools` is inspected
- **THEN** it includes the ChEMBL tools (e.g. `searchTargets`, `getBioactivity`) and PubChem tools (e.g. `searchPubchemCompound`, `getPubchemCrossRefs`)

### Requirement: Agent metadata

The agent SHALL export an `AgentMeta` with `id: "cheminformatics-agent"`;
`skills: ["cheminformatics", "shared/omics-general"]`; `capabilities` and
`suitableFor` covering molecular property profiling, scaffold decomposition,
structural-alert filtering, SAR analysis, QSAR modeling, ADMET prediction,
chemical-space visualization, target-engagement/occupancy assessment,
perturbation-signature / CMap-style connectivity scoring, and
selectivity / kinase-selectivity profiling; and `tools` as above. The metadata
SHALL NOT include a `languages` field (the `AgentMeta` shape has none). The agent
is plannable (the default — `meta` does not set `plannable: false`).

#### Scenario: Metadata shape matches AgentMeta

- **WHEN** the exported `meta` is inspected
- **THEN** `skills` is `["cheminformatics", "shared/omics-general"]`
- **AND** there is no `languages` property
- **AND** `capabilities` and `suitableFor` cover SAR, QSAR, ADMET, target engagement, connectivity scoring, and selectivity profiling

#### Scenario: Agent appears in the plannable catalog

- **WHEN** `PLANNABLE_AGENT_CATALOG` is inspected
- **THEN** it contains a `"cheminformatics-agent"` entry projecting its `capabilities` and `suitableFor`

### Requirement: Agent prompt references the skill, not a duplicated tree

The agent SHALL load `cheminformaticsAgentPrompt` from
`prompts/sandbox/cheminformatics-agent.ts`, composed by `createSandboxAgent` with
the shared sandbox orientation. The prompt SHALL point the agent at its
`cheminformatics` skill (via `skill_search` / `skill_read`) for the
method-selection decision tree and API references rather than re-stating them;
it SHALL require standardize-first structure handling (datamol
`standardize_mol`); and it SHALL describe the input modes including
target-based compound acquisition through the ChEMBL tools and PubChem
resolution.

#### Scenario: Prompt delegates method selection to the skill

- **WHEN** the prompt is inspected
- **THEN** it directs the agent to use `skill_search` / `skill_read` on the `cheminformatics` skill for decision trees and API detail
- **AND** it does not duplicate the full SKILL.md method-selection tree

#### Scenario: Prompt covers standardization and compound acquisition

- **WHEN** the prompt is inspected
- **THEN** it requires standardizing structures (datamol `standardize_mol`) before analysis
- **AND** it describes acquiring compound data via the ChEMBL tools for target-based input and PubChem resolution when compounds are absent from ChEMBL

### Requirement: Registration in the sandbox catalog

The agent SHALL be registered in `SANDBOX_AGENT_META` (`agents/sandbox/index.ts`)
and constructed by `createSandboxAgents(deps)`; the planner-facing
`PLANNABLE_AGENT_CATALOG` and `KNOWN_AGENT_IDS` (`agents/sandbox-catalog.ts`)
SHALL derive from that source.

#### Scenario: Agent is registered and constructible

- **WHEN** `SANDBOX_AGENT_META` is inspected
- **THEN** it contains a `"cheminformatics-agent"` entry
- **AND** `createSandboxAgents(deps)` returns an `AgentDefinition` keyed by `"cheminformatics-agent"`
