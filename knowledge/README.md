# The Inflexa knowledge plane, Phase 0

A remote knowledge service that gives Inflexa its method choices as cited,
versioned rules and tested script templates. The model fills typed
parameters. The service does the deterministic work. Phase 0 proves it on bulk
RNA-seq with three tools, one plan-step field, and no other change to Inflexa.

The design is `../knowledge-plane-phase-zero.html`. This directory holds the
knowledge as code, the build, the service, and the evaluation.

## Layout

| Path | Holds |
| --- | --- |
| `schema/inflexa-knowledge.yaml` | The LinkML model of the knowledge. `src/model.ts` mirrors it in Zod. |
| `kb/rules/` | One rule per file. A rule is a situation-to-method claim with conditions, a strength, and cited evidence. |
| `kb/methods/` | One method per file: a procedure with its packages and its templates. |
| `kb/templates/<id>/` | A template: `template.yaml` (the parameter contract, the outputs, the pins, the tests) and `body.R`. |
| `kb/sources/` | The resolvable locators of every cited source. Never the full text. |
| `kb/modalities/` | The ordered step types of a modality, per question. |
| `kb/vocab/`, `kb/mappings/` | The minted INFLEXA terms and their SSSOM mappings. |
| `src/engine/` | The condition evaluator, the rule match with its hit policy, the procedure assembly, and the check. |
| `src/render/` | The template renderer, the environment match, and the syntax check. |
| `src/build/` | The loader, the referential gate, the snapshot build, and the template test runner. |
| `src/service/` | The typed HTTP service over one snapshot. |
| `eval/` | The simulator, the task set, the runner, the judge, and the report. |
| `dist/snapshots/` | The built snapshots, each named by its date and its digest. |

## The contract

Three operations, one situation schema, one snapshot digest.

| Operation | Caller | In | Out |
| --- | --- | --- | --- |
| `POST /v1/recommend` | the planner | the situation | the match, the procedure with a method, parameters, a template, and claim ids per step, the flags, the claims with evidence, the snapshot |
| `POST /v1/check` | the planner, once | the situation and the drafted steps | violations and warnings, each with a rule id and the permitted alternatives |
| `POST /v1/template/render` | the step agent | a template id, the slot values, the farm versions | the script, the slot report, the environment match, the syntax check, the decision record |

The harness reaches the service through `harness/src/tools/knowledge/`. The
tools attach only when the embedder binds a client. The CLI binds one from
the `knowledge.baseUrl` config key and the `INFLEXA_KNOWLEDGE_API_KEY`
variable. Without them the product runs from the prose skills as before.

## Run it

```bash
bun install
bun run validate            # the gates over kb/
bun run build               # dist/snapshots/<date>-<digest>.sqlite
INFLEXA_KNOWLEDGE_SERVICE_KEY=<key> bun run serve   # http://127.0.0.1:8790
```

Then, in the CLI config, set `knowledge.baseUrl` to the service and export
`INFLEXA_KNOWLEDGE_API_KEY=<key>`.

## The gates

- `bun run validate` reads the tree with the Zod mirror and checks every
  reference: the sources, the methods, the templates, the Situation fields, the
  marked slots, and the claim identifiers. With `--resolve-dois` it asks the
  DOI and PubMed resolvers for each locator.
- `bun run validate:linkml` validates each file against the JSON Schema that
  LinkML generates from the model.
- `bun test` covers the engine, the renderer, the canonical form, and the
  golden test over the curated tree.
- `bun run templates:test` renders each declared template test and runs it in
  the sandbox image with the local package store. Then it compares the
  results with the simulated truth.

## The evaluation

The evaluation compares the planner of the harness with and without the
three tools on eight design patterns. The unit is a task, and the report gives
the paired bootstrap of the rubric difference.

```bash
bun eval/src/simulate.ts                       # the eight datasets
bun eval/src/run.ts --campaign c1 --condition without --model <id> --provider cliproxy --runs 2
bun eval/src/run.ts --campaign c1 --condition with    --model <id> --provider cliproxy --runs 2
bun eval/src/judge.ts  --campaign c1 --judge-model <id> --provider cliproxy
bun eval/src/report.ts --campaign c1
```

A small open model connects with `--provider openai-compatible --base-url
<endpoint> --api-key-env <VAR>`, the same wire as the direct connection mode
of the CLI. The report of the Phase 0 campaign is `eval/results/phase0/report.md`.

## Where this differs from the design document

- The knowledge repository and the service live in this monorepo for Phase 0.
  The design names a private repository. A move is a copy of this directory.
- The airway and pasilla datasets are not in the package store. The template
  tests run on the simulated datasets and compare with the planted truth.
- The simulated datasets come from a base R negative binomial simulator, not
  from compcodeR or Polyester, because neither is staged. The seed and the
  design pattern select each dataset.
- The MCP surface of the service is not built. The harness speaks HTTPS, and
  the curation clients of Phase 0 are the build and the tests.
- The service checks the syntax of a rendered script with `Rscript` when one
  is on its PATH, and it reports `unchecked` otherwise.
