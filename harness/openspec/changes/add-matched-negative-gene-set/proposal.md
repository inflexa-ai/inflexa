# Add a matched negative gene set for a tissue risk benchmark

## Why

A customer builds a classifier that marks a gene as a liver risk when a genetic medicine reduces its expression. The customer has 1215 positive genes, mouse and human mixed. The request also names 2000 negatives. A classifier must not separate the negatives from the positives by liver expression or by network connectivity. Inflexa has the expression table, the network, and the sandbox. But no skill gives the method, and the reference store does not have the phenotype sources that define a negative.

## What Changes

- Six reference datasets in the catalog: IMPC phenotyping 24.0, HPO annotations, Open Targets mouse phenotypes, Open Targets target safety events, and MGI mouse-human homology. The sixth is the STRING aliases file, as a companion dataset of the STRING network. It gives the Ensembl gene id of each STRING protein.
- A reference file in the translational-safety skill pack. It gives the method in six steps: the resolution, the universe and the metrics, the exclusion sources, the two definitions, the matching, and the diagnostics. It also gives the anti-patterns. The tissue is a parameter, and the liver is the worked example.
- A section in the `SKILL.md` of the pack, an entry in its References table, and five anti-patterns.
- Two capability phrases and the `gene-lists` input class on the translational-safety agent. Thus the planner routes the task to that agent.
- The edits of the catalog test: the six ids in its three pinned lists, the MGI host in the official hosts, and the two organism-agnostic ids.

The knowledge plane does not change. No new tool is necessary. The step runs igraph and pandas in the sandbox against the mounted reference store.

## Capabilities

### New Capabilities

- `matched-negative-gene-set`: the datasets, the skill content, and the agent metadata that let one run make a matched negative gene set. The run gives the two definitions, the evidence columns, and the balance report.

### Modified Capabilities

None. The `reference-data-catalog` spec lists no dataset. The `agent-roster` spec has no scenario on the inputs of the translational-safety agent. The `agent-skill-assignment` spec gives the pack count, not the references of a pack.

## Impact

- `harness/src/reference-data/catalog.ts` and `harness/src/reference-data/catalog.test.ts`.
- `harness/src/agents/sandbox/translational-safety-agent.ts`.
- `skills/translational-safety/SKILL.md` and the new `skills/translational-safety/references/matched-negative-gene-set.md`.
- The reference store becomes about 100 MB larger when an embedder installs the six datasets. Each dataset is opt-in, thus a default setup downloads nothing new. No existing dataset changes, thus no install becomes invalid.
- The `gene-lists` input class now matches two agents: the enrichment agent and the translational-safety agent. The planner selects between them by the capability phrases.
- The HPO license has no SPDX identifier. The entry carries `LicenseRef-HPO` and the URL of the license page.
