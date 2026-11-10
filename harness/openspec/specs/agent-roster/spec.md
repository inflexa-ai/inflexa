# agent-roster Specification

## Purpose

Define the sandbox-agent roster — the step agents the harness loop drives, and
the planner-facing catalog the `generate_plan` tool routes against.
`SANDBOX_AGENT_META` (`src/agents/sandbox/index.ts`) is the single source of
truth: a record mapping each agent id to its `AgentMeta`
(`src/agents/sandbox/types.ts`). `KNOWN_AGENT_IDS` is its key set; the
planner-facing `PLANNABLE_AGENT_CATALOG` (`src/agents/sandbox-catalog.ts`) is a
projection that filters out the agents the planner must never assign.

The roster holds two plannable step agents, `analyst` and `drug-analyst`, and the
data profiler. The line between the two step agents follows their tool sets: the
drug, safety, and trial lookups belong to the drug analyst only. An agent
advertises itself to the planner through a short `description`. There is no
`report-renderer` agent: a report page renders in-process in
`src/report-render/`, not in a sandbox agent.

## Requirements

### Requirement: The sandbox-agent catalog is the single source of truth

`SANDBOX_AGENT_META` MUST map every sandbox-agent id to its `AgentMeta`, and
`KNOWN_AGENT_IDS` MUST equal its key set. `AgentMeta` MUST expose exactly the
fields `id`, `description`, `skills`, `tools`, optional `defaultMaxSteps`, and
optional `plannable`.

#### Scenario: The catalog holds the profiler and the two step agents

- **WHEN** the `SANDBOX_AGENT_META` record is inspected
- **THEN** it contains exactly the ids `data-profiler`, `analyst`, and `drug-analyst`
- **AND** `KNOWN_AGENT_IDS` equals `Object.keys(SANDBOX_AGENT_META)`

#### Scenario: AgentMeta carries a description and no capability list

- **WHEN** the `AgentMeta` type is inspected
- **THEN** its fields are `id`, `description`, `skills`, `tools`, `defaultMaxSteps?`, and `plannable?`

### Requirement: The plannable catalog excludes non-plannable agents

`PLANNABLE_AGENT_CATALOG` MUST project `{ id, description, liveSources }` from
every meta whose `plannable` flag is not `false`. `PLANNABLE_AGENT_IDS` MUST be
the non-empty id tuple of the `agent` field of a plan step. Thus the planner can assign only a plannable agent.

#### Scenario: The plannable catalog holds the two step agents

- **WHEN** `PLANNABLE_AGENT_CATALOG` is inspected
- **THEN** it contains exactly the entries of `analyst` and `drug-analyst`

#### Scenario: Infrastructure agents are flagged non-plannable

- **WHEN** the meta of `data-profiler` is inspected
- **THEN** it declares `plannable: false`
- **AND** it appears in neither `PLANNABLE_AGENT_CATALOG` nor `PLANNABLE_AGENT_IDS`

### Requirement: The plannable catalog names the live lookups of each agent

The `liveSources` of a plannable agent MUST name the public database behind each
lookup tool in its `meta.tools`. The planner reads a live lookup as a database
that a step queries at run time, thus the step needs no staged copy of it.
`LIVE_SOURCES` (`src/agents/sandbox-catalog.ts`) MUST hold an entry for each
`SandboxToolName`, and the entry is `null` for a tool that queries no public
database. Thus the typecheck refuses a new tool that has no entry.

#### Scenario: A database that no store stages is a live lookup

- **WHEN** the planner catalog lists the analyst and the drug analyst
- **THEN** the line of the analyst names `gnomAD`, `HumanBase tissue networks`, and `MyGene.info`
- **AND** the line of the drug analyst names `ChEMBL` and `FAERS`

#### Scenario: A tool that queries no public database adds no live lookup

- **WHEN** an agent holds a tool whose `LIVE_SOURCES` entry is `null`
- **THEN** that tool adds no name to the live lookups of the agent

### Requirement: Data-object-based routing

The planner MUST route each step by the primary object that the step works on. A step on compounds, doses,
drug exposure, safety signals, or drug repurposing MUST go to `drug-analyst`. Each other analysis step MUST go
to `analyst`.

#### Scenario: An analysis of data routes to the analyst

- **WHEN** a planned step operates on a count matrix, a cell-level object, a variant file, a result table, or a clinical outcome table
- **THEN** the planner routes it to `analyst`

#### Scenario: Work on compounds routes to the drug analyst

- **WHEN** a planned step operates on compound structures, concentration-time data, adverse-event reports, or candidate drugs for an indication
- **THEN** the planner routes it to `drug-analyst`

#### Scenario: Fallback routing

- **WHEN** the planner finds no other match for a step
- **THEN** it routes the step to `analyst`

### Requirement: Dual-format output convention

A step agent MUST emit a result in its native format and in a generic tabular format. Thus a later step reads a
standard input, and it does not know the source modality.

#### Scenario: The analyst emits native and generic outputs

- **WHEN** `analyst` completes a differential-expression step on single-cell data
- **THEN** it saves the updated AnnData (`.h5ad`) with the DE results in `.uns`
- **AND** it saves a CSV with the gene names, log2FC, p-values, and adjusted p-values
- **AND** a later enrichment step can read either file

### Requirement: The analyst takes each analysis of data

The roster MUST define `analyst`, a plannable step agent for each analysis of data: the omics modalities, the
derived results (gene lists, scores, networks), statistical models of outcomes, genetic variants, and the
preparation of viewer assets. Its prompt MUST state what makes a result valid, and its skills MUST hold the
methods of each domain. It MUST hold every analysis skill.

#### Scenario: The analyst holds the skills of each analysis domain

- **WHEN** the meta of `analyst` is inspected
- **THEN** its `skills` include `bulk-transcriptomics`, `single-cell`, `enrichment`, `statistical-modeling`, `genomic-variants`, `mdv-preparation`, and `shared/omics-general`

#### Scenario: The analyst prepares an MDV asset

- **WHEN** a step asks for a dataset prepared for the Multi-Dimensional Viewer
- **THEN** the step runs on `analyst`
- **AND** the `mdv-preparation` skill gives the workflow and the validation of the asset

### Requirement: The drug analyst takes the work on compounds and exposure

The roster MUST define `drug-analyst`, a plannable step agent for compound structures, pharmacokinetics and
pharmacodynamics, clinical response, translational safety, and drug repurposing. It MUST hold the lookups of
compounds, targets, adverse events, trials, and approvals. Its prompt MUST ask for a source for each claim from a
lookup.

#### Scenario: The drug analyst holds the drug lookups

- **WHEN** the meta of `drug-analyst` is inspected
- **THEN** its `tools` include `chembl`, `pubchem`, `opentargets`, `searchFaers`, and `searchClinicalTrials`
- **AND** its `skills` include `cheminformatics`, `pkpd-clinical-response`, `translational-safety`, and `drug-repurposing`

#### Scenario: The analyst holds no drug lookup

- **WHEN** the meta of `analyst` is inspected
- **THEN** its `tools` include none of `chembl`, `pubchem`, `searchFaers`, `searchClinicalTrials`, and `searchRegulatoryApprovals`
