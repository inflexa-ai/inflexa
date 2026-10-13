# Proposal

## Why

GitHub issue #647: a host cannot show the files of an analysis or the artifact count of a run. It cannot show the synthesis of a run without a replay of the run stream. The harness reads each artifact of an analysis with no page and no filter (`src/state/artifacts.ts:226-245`). The artifact count of a run serves only the run-completed card (`src/state/artifacts.ts:247-258`).

The synthesis is the file `runs/<runId>/synthesis.json`, and no harness read gives it. The contract finding of the synthesis part has no `references`, although the stored finding has them (`src/schemas/run-synthesis.ts:51`).

The harness is the product core. Thus the reads come first in the harness, and the cli connects them in a companion change with the same name.

## What Changes

- A paged read of the artifact ledger of one analysis. It takes the filters `runId`, `stepId`, `fileType`, and `q` (a part of the path, with no regard to case), the sort `path` or `recent`, and a limit and an offset. It gives one page of rows and the exact count of the rows that the filters select.
- **BREAKING** The run artifact count becomes a grouped read: one statement gives the step-output count of each run of a list. `countArtifactsForRun` goes away, and the run-completed card uses the grouped read with one run.
- A read of the synthesis record of a run. It reads `synthesis.json` under a byte cap, validates it with the stored synthesis schema, and gives the flat `data-run-synthesis` part that the run stream carries. It gives `null` when no valid record is on disk.
- The bounded read of a synthesis record moves beside the synthesis writer. The report snapshot pin and the new read use the one helper.
- **BREAKING** The contract `SynthesizedFinding` and its schema get the required field `references`: the PMID, the citation, the relevance, and the concordance of each paper.
- The package root exports the two ledger reads, the synthesis read, and their types.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `artifact-manifest`: the ledger helpers get the paged list read and the grouped run count. The single-run count helper goes away.
- `run-synthesis-outcome`: a read gives the validated synthesis record of a run as the flat part, and the finding of the part contract carries its references.

## Impact

- Harness code: `src/state/artifacts.ts`, `src/state/index.ts`, `src/workflows/execute-analysis.ts` (the run-completed count), `src/execution/run-synthesis.ts`, `src/report-model/pin-snapshot.ts`, `src/contracts/chat-parts.ts`, `src/contracts/schemas/chat-parts.ts`, `src/index.ts`, and their tests.
- Database: no migration and no new index. The cost of the list read grows with the ledger of one analysis. `design.md` records the reason.
- Embedders: a consumer of `SynthesizedFindingSchema` now refuses a finding with no `references`. The synthesizer writes `references` on each finding, because the stored schema requires the field. A consumer that names `countArtifactsForRun` moves to the grouped read.
