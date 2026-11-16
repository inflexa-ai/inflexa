## RENAMED Requirements

- FROM: `### Requirement: shared/omics-general is declared by every analysis agent`
- TO: `### Requirement: omics-general is declared by every built-in executor`

## MODIFIED Requirements

### Requirement: Per-agent skill declaration with no central map

The skills of an agent MUST be its resolved `skills` attachments (refer to the
`agent-catalog` capability). A built-in agent MUST declare its default skills in
code. A custom agent MUST name its skills in its definition. The system MUST NOT
keep a central map of omics types, or of any other dimension, to skills. Each
skill name MUST be a skill id of the `SkillStore`.

#### Scenario: Agent meta declares its packs

- **WHEN** the built-in definition of `drug-analyst` is inspected
- **THEN** its default skills are skill ids of the built-in skills

#### Scenario: Adding a pack requires no loader changes

- **GIVEN** a new built-in pack `omics-spatial`
- **WHEN** a developer adds `"omics-spatial"` to the default skills of one built-in agent
- **THEN** no other file changes for that agent to reach the pack
- **AND** no central type-to-skill table is touched

#### Scenario: An agent that needs no domain guidance declares an empty list

- **WHEN** the `data-profiler` agent is defined
- **THEN** its skills list is `[]`
- **AND** its agent definition is wired with no skill tools

#### Scenario: A user attaches a skill to a built-in agent

- **GIVEN** a `builtin` entry for `analyst` whose `add.skills` names `lab-protocols`
- **WHEN** the catalog resolves
- **THEN** `analyst` can read `lab-protocols` through the skill tools

### Requirement: omics-general is declared by every built-in executor

Each built-in executor MUST include `"omics-general"` in its default skills, so
the cross-cutting guidance (AnnData conventions, Python-first patterns,
data-format detection) is available in each analysis run.

#### Scenario: A modality agent declares the shared pack

- **WHEN** the built-in definition of `analyst` is inspected
- **THEN** its default skills contain `"bulk-transcriptomics"` and `"omics-general"`

### Requirement: Skill pack inventory

The `skills/` tree MUST contain 20 packs: 19 agent-specific packs and the
shared `omics-general` pack.

The `report-html`, `report-pdf`, and `report-pptx` packs are REMOVED: no agent
declares them. The report path renders in-process in `src/report-render/`, and
it reads no skill pack.

#### Scenario: The inventory matches the agent roster

- **WHEN** the `skills/` tree is listed
- **THEN** the 19 agent-specific packs exist: `bulk-transcriptomics`, `single-cell`, `multimodal-single-cell`, `spatial-omics`, `proteomics`, `metabolomics`, `genomic-variants`, `dna-methylation`, `chromatin-regulation`, `microbiome`, `enrichment`, `network-regulatory`, `statistical-modeling`, `multi-omics-integration`, `cheminformatics`, `drug-repurposing`, `immune-profiling`, `pkpd-clinical-response`, `translational-safety`
- **AND** the shared pack `omics-general` exists
- **AND** none of `report-html`, `report-pdf`, and `report-pptx` exists

### Requirement: SKILL.md format

Each `SKILL.md` MUST begin with YAML frontmatter that holds `name` and
`description`, and the format MUST obey the Agent Skills standard. The `name`
MUST equal the directory name of the pack. Other fields, for example `version`
and `tags`, MUST go under `metadata`. The markdown body of a built-in pack MUST
contain a method-selection decision tree and a domain-specific "Do NOT" section.
It MUST point into the `references/` files of the pack.

#### Scenario: Manifest frontmatter is well-formed

- **GIVEN** `skills/bulk-transcriptomics/SKILL.md`
- **WHEN** the file is parsed as YAML
- **THEN** the frontmatter has `name: bulk-transcriptomics` and a non-empty `description`
- **AND** `version` and `tags` are under `metadata`

#### Scenario: Body carries a decision tree and anti-patterns

- **WHEN** a pack's `SKILL.md` body is read
- **THEN** it contains a method-selection decision tree, for example raw counts and two conditions → PyDESeq2, and pre-normalized data → limma
- **AND** it contains a "Do NOT" section listing domain failure modes, for example "Do NOT run DESeq2 on TPM/FPKM data — it requires raw counts"
- **AND** it references files in `references/` for API detail

### Requirement: Agents reach skills via skill_search and skill_read

The harness MUST give each agent of each role the tools `skill_search` and
`skill_read`. The two tools use the `SkillStore` and the resolved skills of the agent.
Both tools MUST be confined to those skills, and an agent MUST NOT read a skill
that it does not attach. `skill_search` MUST match keywords as substrings over
the text files of the attached skills, with no vector, embedding or BM25 index.
It MUST return matches as `{ skill, path, line, snippet, score }`. `skill_read`
MUST return the content of a named file, and `SKILL.md` when the call names no
file. Both tools MUST return the expected outcomes (no skills, an undeclared
skill, a missing path, no matches) as data variants, and they MUST NOT throw.

#### Scenario: Search is confined to declared packs

- **GIVEN** an agent whose resolved skills are `["cheminformatics", "omics-general"]`
- **WHEN** `skill_search` runs a query
- **THEN** only files of `cheminformatics` and `omics-general` are scanned
- **AND** matches carry the pack name, in-pack relative path, line number, and a snippet

#### Scenario: Reading an undeclared pack returns a data variant

- **WHEN** `skill_read` is called with a `skill` that the agent does not attach
- **THEN** it returns `{ status: "skill_not_declared" }` rather than throwing

#### Scenario: No matches returns a data variant

- **WHEN** `skill_search` finds no matching text
- **THEN** it returns `{ status: "no_matches" }` rather than throwing or returning an error result

## REMOVED Requirements

### Requirement: Skills tree layout and pack anatomy

**Reason**: the shared pack moves from `skills/shared/omics-general` to `skills/omics-general`, and the harness reads packs through a `SkillStore`, not a `skillsDir`.

**Migration**: refer to the ADDED requirement "Built-in skill packs are directories one level deep".

### Requirement: Boot-time skill validation

**Reason**: a defect of the built-in content must fail in CI, not stop a released install. Custom content must never stop the boot.

**Migration**: a CI test checks the built-in skills and the default attachments (refer to the `skill-store` capability). A reference to a missing skill in a catalog entry becomes a gap (refer to the `agent-catalog` capability).

## ADDED Requirements

### Requirement: Built-in skill packs are directories one level deep

The built-in skill packs MUST be directories under the root `skills/` tree, one
level deep. Each pack MUST contain a `SKILL.md` manifest. A pack can contain a
`references/` subdirectory of per-package API reference files. The harness MUST
read each pack through the `SkillStore` of the catalog (refer to the
`skill-store` capability).

#### Scenario: An agent-specific pack has a manifest and references

- **GIVEN** the pack `bulk-transcriptomics`
- **WHEN** its directory is listed
- **THEN** `skills/bulk-transcriptomics/SKILL.md` exists
- **AND** `skills/bulk-transcriptomics/references/` holds per-package API files

#### Scenario: The shared pack is one level deep

- **WHEN** the shared pack is located
- **THEN** `skills/omics-general/SKILL.md` exists, and `skills/shared/` does not exist
