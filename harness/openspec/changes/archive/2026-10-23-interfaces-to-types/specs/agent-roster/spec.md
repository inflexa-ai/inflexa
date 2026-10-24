## MODIFIED Requirements

### Requirement: The sandbox-agent catalog is the single source of truth

`SANDBOX_AGENT_META` SHALL map every sandbox-agent id to its `AgentMeta`, and
`KNOWN_AGENT_IDS` SHALL equal its key set. `AgentMeta` SHALL expose exactly the
fields `id`, `capabilities`, `suitableFor`, `skills`, `tools`, optional
`defaultMaxSteps`, and optional `plannable`; it SHALL NOT carry a `tier` or
`languages` field.

#### Scenario: Catalog contains all 21 agents

- **WHEN** the `SANDBOX_AGENT_META` record is inspected
- **THEN** it contains exactly 21 entries with the ids `data-profiler`, `bulk-transcriptomics-agent`, `single-cell-agent`, `multimodal-sc-agent`, `spatial-omics-agent`, `proteomics-agent`, `metabolomics-agent`, `genomic-variant-agent`, `dna-methylation-agent`, `chromatin-agent`, `microbiome-agent`, `enrichment-agent`, `network-agent`, `statistical-modeling-agent`, `multi-omics-integration-agent`, `cheminformatics-agent`, `translational-safety-agent`, `pkpd-clinical-response-agent`, `immune-profiling-agent`, `drug-repurposing-agent`, and `scientific-executor`
- **AND** `KNOWN_AGENT_IDS` equals `Object.keys(SANDBOX_AGENT_META)`

#### Scenario: AgentMeta carries no tier or languages field

- **WHEN** the `AgentMeta` type is inspected
- **THEN** its fields are `id`, `capabilities`, `suitableFor`, `skills`, `tools`, `defaultMaxSteps?`, and `plannable?`
- **AND** neither a `tier` nor a `languages` field is present
