# Proposal: declare-the-column-meaning

## Why

The renderer guesses what a column means from its name. `P_VALUE_TOKENS` (`src/report-render/number-format.ts:50`) matches name tokens, and the guess is fragile. A name outside the list misses, for example `significance`. A `q` column that is not a probability hits. The agent read the artifact, and it knows which column holds a p-value. The system asks the name instead of the author.

## What Changes

- The whole-table binding (`ArtifactTableReferenceSchema`, `src/contracts/report-reference.ts:104`) gains two optional maps: `columnMeanings` (column name to a meaning) and `columnLabels` (column name to a display label).
- The meanings are a closed set: `p-value`, `effect`, `count`, `identifier`, `category`. A meaning is content — what the column is — and it is not a format.
- The design source keeps the one rule for how each meaning renders. The number-kind resolution reads a declared meaning first, and the name-token guess demotes to the fallback.
- A declared display label names the column on the page: the table header, and the axis title of a chart bound to the table. The raw name rides on hover.
- The field descriptions teach the declaration, thus the authoring tools carry it to the agent with no prompt change.
- A key that names no real column is ignored, because absence is a normal condition.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-block-model`: the table binding carries the two optional declaration maps.
- `report-render`: the number-kind resolution reads the declaration first, and a declared label names the header and the axis.

## Impact

- Affected code: `src/contracts/report-reference.ts`, `src/report-render/number-format.ts`, the table view, the chart derivation, and their tests.
- Both fields are optional, thus every stored document keeps rendering, and the token fallback keeps the old behavior.
