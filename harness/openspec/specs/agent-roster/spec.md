# agent-roster Specification

## Purpose

Define the sandbox-agent roster — the fixed set of bioinformatics specialists
the harness loop can drive, and the planner-facing catalog the `generate_plan`
tool routes against. `SANDBOX_AGENT_META` (`src/agents/sandbox/index.ts`) is the
single source of truth: a record mapping each agent id to its `AgentMeta`
(`src/agents/sandbox/types.ts`). `KNOWN_AGENT_IDS` is its key set; the
planner-facing `PLANNABLE_AGENT_CATALOG` (`src/agents/sandbox-catalog.ts`) is a
projection that filters out the agents the planner must never assign.

The roster groups conceptually into modality specialists (one per omics data
type, each owning method selection for its domain), cross-cutting analysis
agents (operating on generic derived data — gene lists, matrices, ranked
lists), drug-discovery / translational agents, and infrastructure agents (the
data profiler and the two executors). These groupings are descriptive prose
only — `AgentMeta` carries **no** `tier` and **no** `languages` field; an agent
advertises itself solely through `capabilities` and `suitableFor`. There is no
`report-renderer` agent: reports render in-process via the Nunjucks renderer,
not as a sandbox agent.

## Requirements

### Requirement: The sandbox-agent catalog is the single source of truth

`SANDBOX_AGENT_META` SHALL map every sandbox-agent id to its `AgentMeta`, and
`KNOWN_AGENT_IDS` SHALL equal its key set. `AgentMeta` SHALL expose exactly the
fields `id`, `capabilities`, `suitableFor`, `skills`, `tools`, optional
`defaultMaxSteps`, and optional `plannable`; it SHALL NOT carry a `tier` or
`languages` field.

#### Scenario: Catalog contains all 22 agents

- **WHEN** the `SANDBOX_AGENT_META` record is inspected
- **THEN** it contains exactly 22 entries with the ids `data-profiler`, `bulk-transcriptomics-agent`, `single-cell-agent`, `multimodal-sc-agent`, `spatial-omics-agent`, `proteomics-agent`, `metabolomics-agent`, `genomic-variant-agent`, `dna-methylation-agent`, `chromatin-agent`, `microbiome-agent`, `enrichment-agent`, `network-agent`, `statistical-modeling-agent`, `multi-omics-integration-agent`, `cheminformatics-agent`, `translational-safety-agent`, `pkpd-clinical-response-agent`, `immune-profiling-agent`, `drug-repurposing-agent`, `scientific-executor`, and `ephemeral-executor`
- **AND** `KNOWN_AGENT_IDS` equals `Object.keys(SANDBOX_AGENT_META)`

#### Scenario: AgentMeta carries no tier or languages field

- **WHEN** the `AgentMeta` interface is inspected
- **THEN** its fields are `id`, `capabilities`, `suitableFor`, `skills`, `tools`, `defaultMaxSteps?`, and `plannable?`
- **AND** neither a `tier` nor a `languages` field is present

### Requirement: The plannable catalog excludes non-plannable agents

`PLANNABLE_AGENT_CATALOG` SHALL project `{ id, capabilities, suitableFor }` from
every meta whose `plannable` flag is not `false`. `PLANNABLE_AGENT_IDS` SHALL be
the non-empty id tuple used as the `z.enum` domain for the plan step's `agent`
field, so the planner can only assign a plannable agent.

#### Scenario: Plannable catalog has 19 entries

- **WHEN** `PLANNABLE_AGENT_CATALOG` is inspected
- **THEN** it contains exactly 19 entries — every agent except `data-profiler`, `scientific-executor`, and `ephemeral-executor`

#### Scenario: Infrastructure agents are flagged non-plannable

- **WHEN** the metas for `data-profiler`, `scientific-executor`, and `ephemeral-executor` are inspected
- **THEN** each declares `plannable: false`
- **AND** none of them appears in `PLANNABLE_AGENT_CATALOG` or `PLANNABLE_AGENT_IDS`

### Requirement: Modality specialists own method selection

The roster SHALL define one modality specialist per omics data type. Each
modality agent SHALL own method selection for its domain — given a goal-oriented
task it decides which algorithm, package, and parameters to use from the data
characteristics — and SHALL advertise its coverage through `suitableFor`.

#### Scenario: Single-cell agent covers scRNA-seq and snRNA-seq

- **WHEN** a step operates on single-cell or single-nucleus RNA-seq data
- **THEN** `single-cell-agent` is the appropriate agent
- **AND** its `suitableFor` includes `scrna-seq` and `snrna-seq`

#### Scenario: Genomic-variant agent covers variant calling and GWAS

- **WHEN** a step operates on VCF/BAM files or PLINK data for variant analysis
- **THEN** `genomic-variant-agent` is the appropriate agent
- **AND** its `suitableFor` includes `wgs`, `wes`, and `gwas`

### Requirement: Cross-cutting agents operate on generic derived data

The roster SHALL define cross-cutting analysis agents — `enrichment-agent`,
`network-agent`, `statistical-modeling-agent`, and
`multi-omics-integration-agent` — that operate on generic derived data (gene
lists, score matrices, ranked lists, tabular features). They SHALL NOT require
modality-specific data objects as input.

#### Scenario: Enrichment agent consumes gene lists

- **WHEN** a step performs pathway or gene-set enrichment on a gene list or ranked gene list
- **THEN** `enrichment-agent` is the appropriate agent
- **AND** it does not require knowledge of the source modality

#### Scenario: Statistical-modeling agent handles survival, ML, and biomarkers

- **WHEN** a step performs survival analysis, classification/regression, mixed-effects modeling, or biomarker discovery on tabular features
- **THEN** `statistical-modeling-agent` is the appropriate agent
- **AND** its `suitableFor` includes `survival`, `classification`, `regression`, and `biomarker-discovery`

### Requirement: Drug-discovery and translational agents

The roster SHALL define drug-discovery / translational specialists —
`cheminformatics-agent`, `translational-safety-agent`,
`pkpd-clinical-response-agent`, `immune-profiling-agent`, and
`drug-repurposing-agent` — each advertising its scope through `capabilities` and
`suitableFor`.

#### Scenario: Cheminformatics agent covers chemical-structure data

- **WHEN** a step operates on chemical structures, SMILES, or compound-activity data
- **THEN** `cheminformatics-agent` is the appropriate agent
- **AND** its `suitableFor` includes `chemical-structures` and `smiles-data`

### Requirement: Scientific-executor is the non-plannable fallback

`scientific-executor` SHALL serve as the explicit last-resort fallback for tasks
that match no specialist. It SHALL NOT appear in the plannable catalog and SHALL
be reachable only by its id, not by catalog lookup.

#### Scenario: Scientific-executor reached only by id

- **WHEN** the planner cannot route a step to any plannable agent
- **THEN** `scientific-executor` is absent from `PLANNABLE_AGENT_CATALOG`
- **AND** the planner's routing instructions name `scientific-executor` as a last-resort fallback accessed by id

### Requirement: Data-object-based routing

The planner SHALL route each step to an agent based on the primary data object
the step operates on, falling back to `scientific-executor` when no specialist
or cross-cutting agent matches.

#### Scenario: Routing by modality-specific data object

- **WHEN** a planned step operates on an AnnData object containing single-cell RNA-seq data
- **THEN** the planner routes it to `single-cell-agent`
- **AND** a step on VCF/BAM files routes to `genomic-variant-agent`

#### Scenario: Routing by generic derived data

- **WHEN** a planned step consumes a gene-list CSV produced by a prior step for pathway enrichment
- **THEN** the planner routes it to the matching cross-cutting agent (e.g. `enrichment-agent`)

#### Scenario: Fallback routing

- **WHEN** the planner cannot determine an appropriate specialist or cross-cutting agent
- **THEN** it routes the step to `scientific-executor` with a note explaining why no specialist applied

### Requirement: Dual-format output convention

Modality specialists SHALL emit results in both their native format and a
generic tabular format, so cross-cutting agents can consume standardized inputs
without knowing the source modality.

#### Scenario: Modality agent emits native and generic outputs

- **WHEN** `single-cell-agent` completes a differential-expression step
- **THEN** it saves the updated AnnData (`.h5ad`) with DE results in `.uns`
- **AND** it saves a CSV with gene names, log2FC, p-values, and adjusted p-values
- **AND** downstream enrichment can consume either file
