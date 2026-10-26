# Proposal

## Why

The file picker of Flamme (inflexa-ai/himmel#111) shows the step that wrote each file of a folder page. GitHub issue inflexa-ai/inflexa#715 asks for one ledger read for each page of the cli folder list. The read must use an `IN` list over the key `(analysis_id, path)` of `cortex_artifacts`. No read of the harness takes a list of paths and gives the run and the step of each path:

- `queryArtifactPage` (`src/state/artifacts.ts:314-374`) selects one exact path with each call, thus a page of 200 entries costs 200 calls.
- `queryInputArtifacts` (`src/state/artifacts.ts:138-160`) takes a list of paths, but it gives only the `input` rows, and no run or step.

The harness is the product core. Thus the read comes first in the harness, and the cli connects it in a companion change with the same name.

## What Changes

- A new read `queryArtifactOrigins(pool, analysisId, paths)` gives `{path, runId, stepId}` for each path of the list that has a ledger row of the analysis. It sends one statement for the whole list, and none for an empty list.
- The state barrel and the package root export the read and the type of its entry.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `artifact-manifest`: a new read gives the run and the step of each path of a list in one statement. The ledger helper list names it, and the package root exports it.

## Impact

- Harness code: `src/state/artifacts.ts`, `src/state/index.ts`, `src/index.ts`, and the tests `src/state/test/artifacts.page.test.ts` and `src/state/test/artifact-reads.barrel.test.ts`.
- Database: no migration. The read uses the primary key `(analysis_id, path)`.
- Embedders: the change only adds an export.
