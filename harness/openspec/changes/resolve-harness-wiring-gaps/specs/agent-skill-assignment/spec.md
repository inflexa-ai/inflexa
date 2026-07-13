# agent-skill-assignment — delta

> Decision 2 (boot ownership) resolved: the harness owns an ordered boot
> sequence (`bootHarness`, `runtime/boot.ts`) that runs `validateAgentSkills`
> before DBOS launch. `assembleCoreRuntime` stays sync and pure.

## MODIFIED Requirements

### Requirement: Boot-time skill validation

At startup the harness SHALL verify (via `validateAgentSkills`) that `skillsDir`
exists and that every skill declared by every agent in the catalog resolves to a
readable `SKILL.md`. A declared pack with no readable manifest SHALL fail
validation before the first analysis runs, naming the offending agent and skill.

This check SHALL be invoked from the harness-owned boot sequence
`bootHarness` (`runtime/boot.ts`), using the `skillsDir` the embedder threads in
and the harness-owned agent catalog (`SANDBOX_AGENT_META`). It SHALL run before
DBOS launch — after the injected telemetry init and before state init, the
connection-budget guard, `assembleCoreRuntime`, and `launchDbos` — so a
`meta.skills` typo or a `skillsDir` / image drift fails in milliseconds, before
any Postgres or DBOS cost is paid. `bootHarness` therefore SHALL require
`skillsDir` as an input.

#### Scenario: A typo in meta.skills fails fast

- **GIVEN** an agent declaring a skill whose `SKILL.md` does not exist under `skillsDir`
- **WHEN** `validateAgentSkills` runs at boot
- **THEN** it throws, naming the agent id, the missing skill, and the expected path

#### Scenario: Boot fails on an unreadable pack before any launch work

- **GIVEN** `bootHarness` is called with a `skillsDir` under which a declared pack has no readable `SKILL.md`
- **WHEN** the harness boots
- **THEN** `bootHarness` SHALL reject before state init, the connection-budget guard, and `launchDbos` run, so no durable engine is launched

### Requirement: Skill pack inventory

The `skills/` tree SHALL contain 21 packs: 19 agent-specific packs, the shared
`shared/omics-general` pack, and 1 report pack (`report-html`).

The `report-pdf` and `report-pptx` packs are REMOVED: no agent declared them,
no roster loaded them, and no report path renders PDF or PPTX — they were orphan
content referenced only by the skills `README.md`. A PDF/PPTX report path, if
built, SHALL re-introduce its pack as a first-class rostered capability.

#### Scenario: The inventory matches the agent roster

- **WHEN** the `skills/` tree is listed
- **THEN** the 19 agent-specific packs exist: `bulk-transcriptomics`, `single-cell`, `multimodal-single-cell`, `spatial-omics`, `proteomics`, `metabolomics`, `genomic-variants`, `dna-methylation`, `chromatin-regulation`, `microbiome`, `enrichment`, `network-regulatory`, `statistical-modeling`, `multi-omics-integration`, `cheminformatics`, `drug-repurposing`, `immune-profiling`, `pkpd-clinical-response`, `translational-safety`
- **AND** the shared pack `shared/omics-general` exists
- **AND** the report pack `report-html` exists
- **AND** neither `report-pdf` nor `report-pptx` exists
