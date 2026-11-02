## MODIFIED Requirements

### Requirement: Skill pack inventory

The `skills/` tree SHALL contain 21 packs: 20 agent-specific packs and the
shared `shared/omics-general` pack.

The `report-html`, `report-pdf`, and `report-pptx` packs are REMOVED: no agent
declares them, and no roster loads them. The report path renders in-process in
`src/report-render/`, and it reads no skill pack. A report pack, if built,
SHALL re-introduce itself as a first-class rostered capability.

#### Scenario: The inventory matches the agent roster

- **WHEN** the `skills/` tree is listed
- **THEN** the 20 agent-specific packs exist: `bulk-transcriptomics`, `single-cell`, `multimodal-single-cell`, `spatial-omics`, `proteomics`, `metabolomics`, `genomic-variants`, `dna-methylation`, `chromatin-regulation`, `microbiome`, `enrichment`, `network-regulatory`, `statistical-modeling`, `multi-omics-integration`, `cheminformatics`, `drug-repurposing`, `immune-profiling`, `pkpd-clinical-response`, `translational-safety`, `mdv-preparation`
- **AND** the shared pack `shared/omics-general` exists
- **AND** none of `report-html`, `report-pdf`, and `report-pptx` exists
