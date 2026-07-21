# agent-skill-assignment Specification

## Purpose

Define how sandbox agents declare and consume **skills** — the runtime
knowledge packs (method decision trees, per-package API references, worked
examples) the harness loads at analysis time. The model has one invariant:
each agent's `AgentMeta.skills` array is the *single* source of which packs that
agent may read. There is no central omics-type→skill map and no build-time
indexing step; adding a pack and naming it in an agent's `meta.skills` is the
whole wiring. Packs live as directories under the root `skills/` tree, read at
runtime through the injected `skillsDir` (so the same content serves the OSS host
and a managed deployment).

Agents reach their declared packs through two leaf tools — `skill_search`
(keyword/substring match) and `skill_read` — built by `createSkillTools` in
`tools/sandbox/skills.ts` and confined to the agent's own allowlist. The search
is a bounded text scan, not a vector/embedding/BM25 index: a per-agent skill set
is a handful of directories, so a cheap scan is enough to route the agent to the
right reference. There is no `resolveSkillPaths`, `createWorkspaceForStep`,
`StepMetadata`, or BM25 indexing — skills are not "injected into a workspace";
they are read on demand, file by file, within the declared allowlist.
## Requirements
### Requirement: Per-agent skill declaration with no central map

Each sandbox agent's `AgentMeta` SHALL carry a `skills: readonly string[]` field
naming the skill packs that agent may read. The system SHALL NOT maintain any
centralized mapping of omics types (or any other dimension) to skill directories;
skill access SHALL be fully determined by each agent's own `meta.skills`. Names
without a prefix resolve to `skills/<name>/`; names with the `shared/` prefix
resolve to `skills/shared/<name>/`.

#### Scenario: Agent meta declares its packs

- **WHEN** a sandbox agent meta is defined (e.g. `cheminformatics-agent`)
- **THEN** its `AgentMeta` carries a `skills` array of pack directory names
- **AND** each entry resolves to a directory under `skills/`

#### Scenario: Adding a pack requires no loader changes

- **GIVEN** a new pack directory `skills/omics-spatial/` is created
- **WHEN** a developer adds `"omics-spatial"` to one agent's `meta.skills`
- **THEN** no other file is modified for that agent to reach the pack
- **AND** no central type-to-skill table is touched

#### Scenario: An agent that needs no domain guidance declares an empty list

- **WHEN** the `data-profiler` agent is defined
- **THEN** its `skills` array is `[]`
- **AND** its agent definition is wired with no skill tools

### Requirement: shared/omics-general is declared by every analysis agent

Every analysis sandbox agent (every plannable agent plus the executors) SHALL
include `"shared/omics-general"` in its `meta.skills`, so cross-cutting guidance
(AnnData conventions, Python-first patterns, data-format detection) is available
in every analysis run. The non-analysis `data-profiler` is the only agent that
declares no skills.

#### Scenario: A modality agent declares the shared pack

- **WHEN** the `bulk-transcriptomics-agent` meta is inspected
- **THEN** its `skills` array contains `"bulk-transcriptomics"` and `"shared/omics-general"`

### Requirement: Skills tree layout and pack anatomy

Skill packs SHALL be organized under the root `skills/` tree in three
categories: agent-specific packs at `skills/<name>/`, the shared pack at
`skills/shared/omics-general/`, and report packs at `skills/report-<format>/`.
Each pack SHALL contain a `SKILL.md` manifest and MAY contain a `references/`
subdirectory of per-package API reference files. The tree root is supplied to
the harness as the injected `skillsDir` (a `SandboxAgentDeps.skillsDir`); when it
is omitted, the skill tools are not wired.

#### Scenario: An agent-specific pack has a manifest and references

- **GIVEN** the pack `bulk-transcriptomics`
- **WHEN** its directory is listed
- **THEN** `skills/bulk-transcriptomics/SKILL.md` exists
- **AND** `skills/bulk-transcriptomics/references/` holds per-package API files

#### Scenario: The shared pack lives under skills/shared

- **WHEN** the shared pack is located
- **THEN** `skills/shared/omics-general/SKILL.md` exists

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

### Requirement: SKILL.md format

Each pack's `SKILL.md` SHALL begin with YAML frontmatter carrying `name`,
`description`, `version`, and `tags`, followed by a markdown body. The body
SHALL contain a method-selection decision tree (mapping data characteristics to
recommended methods), a domain-specific anti-patterns ("Do NOT") section, and
pointers into the pack's `references/` files for detailed API patterns.

#### Scenario: Manifest frontmatter is well-formed

- **GIVEN** `skills/bulk-transcriptomics/SKILL.md`
- **WHEN** the file is parsed
- **THEN** the frontmatter has `name`, a non-empty `description`, a semver `version`, and a `tags` array

#### Scenario: Body carries a decision tree and anti-patterns

- **WHEN** a pack's `SKILL.md` body is read
- **THEN** it contains a method-selection decision tree (e.g. raw counts + two conditions → PyDESeq2; pre-normalized data → limma)
- **AND** it contains a "Do NOT" section listing domain failure modes (e.g. "Do NOT run DESeq2 on TPM/FPKM data — it requires raw counts")
- **AND** it references files in `references/` for API detail

### Requirement: Per-package reference files

A pack's `references/` directory SHALL hold one file per package, each carrying
that package's key usage patterns, constructor/function signatures, and known
gotchas. Reference files SHALL NOT bundle multiple packages into one document.

#### Scenario: One file per package

- **WHEN** `skills/single-cell/references/` is listed
- **THEN** each file covers a single package (e.g. `scanpy-api.md`, `scvi-tools-api.md`)
- **AND** no file combines multiple packages

### Requirement: Agents reach skills via skill_search and skill_read

The harness SHALL expose two leaf tools, `skill_search` and `skill_read`, built
by `createSkillTools({ skillsDir, skills })` in `tools/sandbox/skills.ts`, where
`skills` is the agent's `meta.skills`. Both tools SHALL be confined to that
declared allowlist — an agent SHALL NOT read another agent's packs. `skill_search`
SHALL keyword/substring-match over the declared packs' text files (no
vector/embedding/BM25 index) and return matches as `{ skill, path, line, snippet,
score }`. `skill_read` SHALL return a named file's content. Both SHALL return
expected outcomes (no declared skills, undeclared skill, missing path, no matches)
as data variants and never throw.

#### Scenario: Search is confined to declared packs

- **GIVEN** an agent whose `meta.skills` is `["cheminformatics", "shared/omics-general"]`
- **WHEN** `skill_search` runs a query
- **THEN** only files under `cheminformatics` and `shared/omics-general` are scanned
- **AND** matches carry the pack name, in-pack relative path, line number, and a snippet

#### Scenario: Reading an undeclared pack returns a data variant

- **WHEN** `skill_read` is called with a `skill` not in the agent's allowlist
- **THEN** it returns `{ status: "skill_not_declared" }` rather than throwing

#### Scenario: No matches returns a data variant

- **WHEN** `skill_search` finds no matching text
- **THEN** it returns `{ status: "no_matches" }` rather than throwing or returning an error result

### Requirement: Per-file read cap

`skill_search` SHALL skip any file larger than 512 KiB, and `skill_read` SHALL
truncate content at 512 KiB and report the truncation (a `truncated` variant with
the original `totalSize`). This keeps a scan over a deep reference tree cheap and
context-safe.

#### Scenario: Oversized file is truncated on read

- **GIVEN** a declared-pack file larger than 512 KiB
- **WHEN** `skill_read` reads it
- **THEN** it returns at most 512 KiB of content with a `truncated` status and the original total size

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

