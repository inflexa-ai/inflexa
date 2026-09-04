# Package name resolution: one identity rule for each ecosystem

## Why

A launch refused a plan because the pool holds the Python distribution
`decoupler` and the R package `decoupleR`. The store build lowercases each
R name with the PEP 503 rule, thus the two packages share one lookup key. A
plan cannot name an ecosystem, thus the refusal has no remedy. The agent
obeyed the prompt, and it dropped the method from the analysis.

The fault is not one package. A reconstruction of the pool finds eight
names that both tracks hold: `decoupleR` and `biomaRt` collide only because
of the lowercase rule, and `igraph`, `plotly`, `xgboost`, `markdown`,
`filelock`, and `symengine` are the same spelling in both ecosystems. A
plan that names one of the eight cannot launch today.

## What Changes

- The dependency graph keeps the DESCRIPTION spelling of an R package as
  the node name and as the `by_name` key of the R track. The Python track
  keeps the PEP 503 form. The graph version becomes 2, thus a reader of
  version 1 refuses the new graph, and a reader of version 2 refuses the
  old graph. **BREAKING**: a store of graph version 1 is unusable under the
  new host until `store download --update` replaces it.
- The graph gate stops the build when an R node name differs from its
  DESCRIPTION spelling. It reports the names that both tracks hold with
  one spelling.
- A plan package entry can carry an ecosystem prefix: `python:igraph`,
  `r:decoupleR`. The bare form stays valid. The validation refuses a prefix
  that is not `python:` or `r:`. The link pass passes the ecosystem to the
  seam. The planner prompt teaches the prefix.
- The `names` lookup of `list_available_packages` returns every track
  that holds the name. The listing marks a both-track name with the
  prefixed forms to write.
- The `link_packages` description and the package-link prompt layer teach
  the remedy of a `collision`: call the tool again with the ecosystem. A
  collision is terminal only after that retry.
- The launch refusal names the same remedy for a collision.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `package-store-provisioner`: the graph node name and the `by_name` key
  obey the identity rule of the track. The graph version is 2. The gate
  reports the both-track names and stops a two-spelling key.
- `planning-enhancements`: a plan package entry accepts an ecosystem
  prefix. The validation, the planner prompt, the link pass, and the
  launch refusal obey it.
- `harness-sandbox-agents`: the `link_packages` description and the prompt
  layer teach the ecosystem retry after a `collision`.
- `package-store`: `list_available_packages` answers every track that
  holds a name, and it shows the prefixed form for a both-track name.

## Impact

- `images/sandbox-provisioner/emit_deps.py`: the R node name, the graph
  version, the gate. `images/sandbox-provisioner/test_provision.py`.
- `harness/src/schemas/workflow-state.ts`, `validate-plan.ts`: the entry
  grammar and its validation.
- `harness/src/tools/execute-analysis.ts`: the requirement parser and the
  refusal text.
- `harness/src/tools/sandbox/list-available-packages.ts`: the `names`
  lookup and the listing.
- `harness/src/tools/sandbox/link-packages.ts`,
  `harness/src/prompts/sandbox-standards.ts`, `harness/src/prompts/planner.ts`:
  the agent-facing text.
- `harness/src/sandbox/types.ts`: the shelf-key rule, exported for the
  embedder.
- The companion cli change `package-name-resolution` connects the host
  lookup, the pool inventory, and the graph-version remedy. The two
  changes ship in this order: the harness change first, because the
  prefix resolves every one of the eight names against the current graph.
  The provisioner change and the cli change ship together, because the
  host lookup and the graph key must agree.
