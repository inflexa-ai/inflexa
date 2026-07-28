## MODIFIED Requirements

### Requirement: The sandbox-agent catalog is the single source of truth

`SANDBOX_AGENT_META` SHALL map every sandbox-agent id to its `AgentMeta`, and
`KNOWN_AGENT_IDS` SHALL equal its key set. `AgentMeta` SHALL expose exactly the
fields `id`, `capabilities`, `suitableFor`, `skills`, `tools`, optional
`defaultMaxSteps`, and optional `plannable`; it SHALL NOT carry a `tier` or
`languages` field.

#### Scenario: Catalog contains all 22 agents

- **WHEN** the `SANDBOX_AGENT_META` record is inspected
- **THEN** it contains exactly 22 entries with the ids `data-profiler`, `bulk-transcriptomics-agent`, `single-cell-agent`, `multimodal-sc-agent`, `spatial-omics-agent`, `proteomics-agent`, `metabolomics-agent`, `genomic-variant-agent`, `dna-methylation-agent`, `chromatin-agent`, `microbiome-agent`, `enrichment-agent`, `network-agent`, `statistical-modeling-agent`, `multi-omics-integration-agent`, `cheminformatics-agent`, `translational-safety-agent`, `pkpd-clinical-response-agent`, `immune-profiling-agent`, `drug-repurposing-agent`, `scientific-executor`, and `adhoc-executor`
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
- **THEN** it contains exactly 19 entries — every agent except `data-profiler`, `scientific-executor`, and `adhoc-executor`

#### Scenario: Infrastructure agents are flagged non-plannable

- **WHEN** the metas for `data-profiler`, `scientific-executor`, and `adhoc-executor` are inspected
- **THEN** each declares `plannable: false`
- **AND** none of them appears in `PLANNABLE_AGENT_CATALOG` or `PLANNABLE_AGENT_IDS`
