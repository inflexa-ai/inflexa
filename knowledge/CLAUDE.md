# CLAUDE.md

Guidance for Claude Code that works in the **knowledge** subsystem: the
knowledge plane of Inflexa, Phase 0.

## What this subsystem is

The knowledge plane gives Inflexa its method choices as cited, versioned rules
and tested script templates. A model fills typed parameters. The service does
the deterministic work. This directory holds four things:

- `kb/`, the knowledge as code: one YAML file per rule, method, and template,
  plus the sources, the modalities, and the minted vocabulary.
- `schema/`, the LinkML model of the knowledge, and the source of truth for the
  classes. `src/model.ts` mirrors it in Zod for the runtime.
- `src/`, the build (`build/`), the rule engine (`engine/`), the template
  renderer (`render/`), the snapshot store, and the typed service (`service/`).
- `eval/`, the Phase 0 evaluation: the simulator, the task set, the runner, the
  judge, and the report.

The service is closed and remote in the product. The harness reaches it through
three tools in `harness/src/tools/knowledge/`. The tools are the only contract,
and the snapshot digest is the only shared identifier. Read
`knowledge-plane-phase-zero.html` at the repository root for the design.

## Commands

Work inside this directory. Bun is the runtime and the package manager.

```bash
bun install                 # once; then link the harness for the evaluation (see below)
bun test                    # the engine, the renderer, and the canonical form
bun run typecheck           # tsc --noEmit
bun run validate            # the schema gate (Zod) and the referential gate over kb/
bun run validate -- --resolve-dois   # plus each DOI and PMID against the resolvers
bun run validate:linkml     # the LinkML gate, with linkml on the PATH or a venv python as the argument
bun run build               # write dist/snapshots/<date>-<digest>.sqlite and latest.json
bun run serve               # serve the latest snapshot on 127.0.0.1:8790
bun run templates:test      # render each template test and run it in the sandbox image
```

The evaluation links the working-copy harness the way the CLI does:

```bash
mkdir -p node_modules/@inflexa-ai && ln -s ../../../harness node_modules/@inflexa-ai/harness
```

The harness must be built (`cd ../harness && bun run build`) before the link
resolves its types.

## Rules of the tree

- A rule cites a source id from `kb/sources/` only. Never write a DOI, a PMID,
  or a URL into a rule. A DOI appears only inside a `default_source` locator,
  copied from the sources file.
- A rule is a declarative claim with conditions over the Situation fields, an
  action, a severity, and a strength. It carries at least one evidence line
  with a paraphrase and an anchor. A verbatim span holds at most 25 words.
- The rule with more conditions wins a step type. A broad default has one
  condition. A narrower rule adds conditions. A tie breaks by strength, then
  by id. Give a rule the conditions that make it fire only in its situation.
- A flag rule that removes inference (`outcome: descriptive_only` or a stop)
  and names a method makes that method the only method of the step. The
  other methods of the step are forbidden, not alternatives.
- A method with two or more templates lists them in order. The engine takes
  the first template whose `applicability` holds in the situation, thus a
  template without conditions comes last.
- The golden test `src/service/tree.test.ts` encodes the intended winner of
  each evaluation situation and of the edge situations. A rule that changes
  a winner fails there first. Add a case when you add a situation.
- A template body uses three constructs only: `{{slot}}`, `{{#if slot}}`, and
  `{{#unless slot}}`. Every adaptable slot lands on a line that ends with
  `# [adaptable: slot]`. A pinned slot carries a default and a source.
- A template is R (`body.R`, run with `Rscript`) or Python (`body.py`, run
  with `python3`). A Python template attaches to the same method as its R
  mirror, after the R templates, with the same applicability. The caller
  selects the language with a preference on the recommend request. A
  preference never changes a rule or a method.
- A published snapshot is never edited. A correction is a new snapshot. A rule
  is never deleted. It becomes deprecated with a `replaced_by` link.
- The step order of a modality lives in `kb/modalities/`. A new step type is a
  schema change, in `schema/` and in `src/model.ts` together.
- A new Situation field is a schema change in three places: `schema/`,
  `src/model.ts`, and the situation schema of the harness tools. A condition
  over an absent field is false, thus a rule that names the new field fires
  only when the caller sets it.

## Tests and gates

The evaluation data holds fourteen simulated patterns under `eval/data/`,
each with counts, TPM, log-expression, lengths, metadata, and the truth. The
task set in `eval/tasks/tasks.yaml` names a pattern and the facts of the
profile. A task can set the organism, the data state, an extra results
table, hidden columns, a user constraint, and the expected outcome.

`bun test` covers the engine, the renderer, and the canonical form with no
network and no Docker. `bun run validate` reads the tree. `templates:test`
needs Docker, the sandbox image, and the local package store. It renders each
declared test and runs it in the image with the farm mounted. A test compares
the results with the truth of the simulated dataset. Do not weaken a bound to
make a test pass. Fix the script or the simulation, and say why.

## Documents

Write each document in this directory in Simplified Technical English, as the
root `CLAUDE.md` describes. STE does not control a YAML value or a code file.
