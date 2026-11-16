# skills

## Overview

Runtime knowledge packs that the harness loads into its sandbox agents on demand. They hold method decision trees, API references, and worked examples for the choice and the run of an analysis. These are **not code and not a packaged dependency**: they are plain Markdown that the host gives the harness through the `SkillStore` of its agent catalog.

## What's here

One `SKILL.md` per directory, grouped by domain:

- **Transcriptomics / single-cell** — `bulk-transcriptomics`, `single-cell`, `multimodal-single-cell`, `spatial-omics`
- **Genomics / epigenomics** — `genomic-variants`, `dna-methylation`, `chromatin-regulation`
- **Proteomics / metabolomics** — `proteomics`, `metabolomics`
- **Immunology / microbiome** — `immune-profiling`, `microbiome`
- **Integration / stats** — `multi-omics-integration`, `network-regulatory`, `statistical-modeling`, `enrichment`
- **Chem / drug / translational** — `cheminformatics`, `drug-repurposing`, `translational-safety`, `pkpd-clinical-response`
- **Viewer assets** — `mdv-preparation` (projects for MDV, the Multi-Dimensional Viewer)
- **Cross-cutting** — `omics-general`, which each built-in executor attaches

## Anatomy of a pack

```
skills/<name>/
  SKILL.md          # frontmatter + body
  references/*.md    # deep-dive reference files
```

`SKILL.md` frontmatter is YAML in the Agent Skills format: `name` (equal to the directory name), `description`, and `metadata` with `version` and `tags`. Body convention:

1. **Decision tree** — choose the method from input data + goal.
2. **Constraints** — the goal of the analysis, and the rules that the result must obey.
3. **Anti-Patterns** — the failure modes. Put the gotchas of this environment first.
4. **References table** — maps each `references/*.md` file to its purpose.

`SKILL.md` is the hub. The `references/` files are the heavy detail (full API surfaces, formulas, edge cases) that the agent reads only when it needs them.

## Writing a skill

The readers of a skill include small open models, for example Qwen and GLM. Thus write for a model that knows how to code, but that can get a domain trap wrong.

- **Write the description for the selection.** The agent sees only the `description` of each declared pack until it reads the pack. Start with "Read before you …", and name the inputs and the questions that the pack covers. Write the description on one line, because the harness reads only the line of the `description:` key.
- **Cut what a coding agent does by default.** Examples are file format detection, how to load a file, generic analysis phases, generic plot lists, and package descriptions with no fact about this environment.
- **Keep the domain best practices.** A statistical trap, a threshold, a numeric value, a published list, or a criterion stays, even when a frontier model knows it.
- **Give the gotchas of this environment first.** Examples are data that is not staged, a package that needs the network, and a package default that fails in the sandbox. A trap that an agent hit in an eval is also a gotcha. These facts are not in the training data of any model.
- **State the goal and the constraints, not a sequence of steps.** A decision tree is permitted. A numbered list of fixed steps prevents the agent from an adaptation to the data.
- **Keep the hub short.** Move a long section that only some steps use into a file in `references/`. Add the file to the References table.
- **Obey the layer rules for agent-facing content** in the root `CLAUDE.md`. A skill gives the dataset by name and its contract. It does not name a path, a file format, or a tool.
- **Write the prose in STE**, as the root `CLAUDE.md` tells.

## How it's loaded

The system prompt of each sandbox agent holds an index of its declared packs: the name and the `description` of each pack (`skillIndex` in `harness/src/tools/sandbox/skills.ts`). The agent reads the content with two tools defined in `harness/src/tools/sandbox/skills.ts`:

- `skill_search` — keyword/substring match over the agent's declared packs. It is a bounded text scan, **not** a vector/embedding index. Returns matching files + a line snippet.
- `skill_read` — reads a file, for example a `references/*.md`, from a declared pack, or its `SKILL.md` when the call names no path.

Both are confined to the skills that the agent attaches. Per-file cap is **512 KiB** (`MAX_SKILL_FILE_BYTES`): larger files are skipped by search and truncated by read.

Each built-in agent lists its default packs in `harness/src/catalog/builtins.ts`, and a user can add or remove packs for each agent. A CI test (`harness/src/catalog/test/builtin-content.test.ts`) checks that each default pack exists. **A pack that an agent does not attach is invisible to that agent** — there is no global auto-load.

## Contributing a skill

1. Make `skills/<name>/SKILL.md` plus `references/*.md` for the detail.
2. ALWAYS include an **Anti-Patterns** section and a **References** table — both are load-bearing conventions, not optional.
3. Obey the rules in "Writing a skill".
4. Add the pack to the default skills of the consuming agent in `harness/src/catalog/builtins.ts`. Until you do, the pack will not load for any built-in agent.
