# skills

## Overview

Runtime knowledge packs the harness loads into its sandbox agents on demand — method decision trees, API references, and worked examples that steer how an agent picks and runs an analysis. These are **not code and not a packaged dependency**: they are plain Markdown read at runtime from the directory the harness is pointed at via `skillsDir`.

## What's here

23 packs (one `SKILL.md` per directory), grouped by domain:

- **Transcriptomics / single-cell** — `bulk-transcriptomics`, `single-cell`, `multimodal-single-cell`, `spatial-omics`
- **Genomics / epigenomics** — `genomic-variants`, `dna-methylation`, `chromatin-regulation`
- **Proteomics / metabolomics** — `proteomics`, `metabolomics`
- **Immunology / microbiome** — `immune-profiling`, `microbiome`
- **Integration / stats** — `multi-omics-integration`, `network-regulatory`, `statistical-modeling`, `enrichment`
- **Chem / drug / translational** — `cheminformatics`, `drug-repurposing`, `translational-safety`, `pkpd-clinical-response`
- **Reporting** — `report-html`

`shared/` holds cross-cutting packs declared by (almost) every agent — currently `shared/omics-general`.

## Anatomy of a pack

```
skills/<name>/
  SKILL.md          # frontmatter + body
  references/*.md    # deep-dive reference files
```

`SKILL.md` frontmatter: `name`, `description`, `version`, `tags`. Body convention (see `cheminformatics/SKILL.md`):

1. **Decision tree** — choose the method from input data + goal.
2. **Conventions** — figure/output/parameter rules for the domain.
3. **Anti-Patterns** — an explicit "Do NOT" list of failure modes.
4. **References table** — maps each `references/*.md` file to its purpose.

The `references/` files are the heavy detail (full API surfaces, formulas, edge cases) that the agent reads only when it needs them.

## How it's loaded

Two tools defined in `harness/src/tools/sandbox/skills.ts`:

- `skill_search` — keyword/substring match over the agent's declared packs. It is a bounded text scan, **not** a vector/embedding index. Returns matching files + a line snippet.
- `skill_read` — reads a file (e.g. `SKILL.md` or a `references/*.md`) from a declared pack.

Both are confined to the agent's allowlist. Per-file cap is **512 KiB** (`MAX_FILE_BYTES`): larger files are skipped by search and truncated by read.

Each sandbox agent declares its packs in `meta.skills` (`AgentMeta`, see `harness/src/agents/sandbox/types.ts` and each `*-agent.ts`, e.g. `cheminformatics-agent.ts`). `validate-skills.ts` checks every declared name resolves to a real directory. **A pack not listed in an agent's `meta.skills` is invisible to that agent** — there is no global auto-load. `shared/omics-general` is declared by every analysis agent except the `data-profiler` (which declares none).

## Contributing a skill

1. Create `skills/<name>/SKILL.md` plus `references/*.md` for the detail.
2. ALWAYS include an **Anti-Patterns** section and a **References** table — both are load-bearing conventions, not optional.
3. Declare the pack in the consuming agent's `meta.skills` (`harness/src/agents/sandbox/<agent>.ts`). Until you do, the pack will not load for any agent.
