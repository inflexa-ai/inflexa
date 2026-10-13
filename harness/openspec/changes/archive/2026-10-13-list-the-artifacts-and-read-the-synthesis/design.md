# Design

## Context

See `proposal.md` for the problem. These facts shape the approach:

- `cortex_artifacts` has the primary key `(analysis_id, path)` and the index `idx_cortex_artifacts_run (analysis_id, source_run)` (`src/state/migrations/20260927120000_baseline.ts:53-70`). No index covers `created_at`, `file_type`, `source_step`, or a part of the path.
- The ledger of one analysis can hold tens of thousands of `input` rows (`src/state/artifacts.ts:72-80`). An `input` row has a null `source_run` and a null `file_type`.
- The upsert keeps the first `created_at` of a path (`src/state/artifacts.ts:36-43`). Thus `created_at` is the time of the first registration.
- `countArtifactsForRun` has one caller, the run-completed card step (`src/workflows/execute-analysis.ts:1628`). That step gives a number.
- The report snapshot pin has a bounded read of `synthesis.json` (`src/report-model/pin-snapshot.ts:51-98`). It is private to that file. No read validates the record.
- The synthesis sink writes `flattenDataPart(buildRunSynthesisPart(runId, synthesis))` to the run stream (`src/workflows/execute-analysis.ts:678-685`, `src/execution/run-synthesis.ts:633-647`).
- The run row is the authority on whether a synthesis exists (`run-synthesis-outcome`, Purpose).

## Goals / Non-Goals

**Goals:**

- One page of the ledger for each read, with an exact `total`, in a fixed count of statements.
- One statement for the artifact counts of a page of runs.
- A synthesis read that gives the same part as the run stream.

**Non-Goals:**

- No migration, no new index, and no Postgres extension.
- No `translationalRelevance` in the contract finding. The issue names `references` only. The record and the stream part carry the field at run time, and the contract type does not declare it.
- No change to the run-stream sink, to `inspect_run`, or to the lenient citation parse of the snapshot pin.

## Decisions

### D1. The paged read scans the ledger of one analysis

`queryArtifactPage(pool, analysisId, query)` takes `query: { runId?, stepId?, fileType?, q?, sort, limit, offset }` and gives `ArtifactPage = { entries: ArtifactPageEntry[]; total: number }`. The read builds one `WHERE` text and sends two statements: the count and the page. The count is necessary because the list envelope of an embedder gives an exact `total`. The precedent is `queryRunsForInspection` (`src/state/runs.ts:330-360`).

- Each statement starts with `analysis_id = $1`. Postgres then reads the rows of the one analysis through the leading column of the primary key. A `runId` filter can use `idx_cortex_artifacts_run`.
- `q` uses `strpos(lower(path), lower($q)) > 0`. A `LIKE` pattern makes `%` and `_` wildcards, and `src/execution/dbos-workflow-purger.ts:177-180` refuses `LIKE` for the same reason.
- The sort `path` is the order of the primary key. The sort `recent` is `created_at DESC, path ASC`, and `path` is unique in one analysis. Thus two pages never overlap.

The cost of the read grows with the ledger of the one analysis, because the exact `total` reads each filtered row. The user accepted this cost for `q`. A `q` scan reads the same rows as the count with no filter, thus it does not raise the cost class of the read.

Alternatives:

- A `pg_trgm` GIN trigram index on `path`. Rejected by the user: each embedder Postgres then needs a new extension, and each artifact upsert writes the GIN index. An `input` manifest can hold tens of thousands of rows.
- An index on `(analysis_id, created_at)` for the sort `recent`. Rejected: the count already reads each filtered row, and a top-N sort over the same rows adds no cost class. The index adds a write to each upsert.
- One statement with `COUNT(*) OVER ()`. Rejected: a page past the end gives no row, and thus no `total`.

### D2. The grouped count takes the place of the single-run count

`countArtifactsByRuns(pool, analysisId, runIds)` sends one `GROUP BY source_run` statement over `idx_cortex_artifacts_run`, with `role = 'step_output'`. It is the same count rule as the run-completed card. The single-run helper goes away, and the card step passes its one run. The step still gives a number, thus a replay of an old step result stays correct.

Alternative: keep `countArtifactsForRun` and add the grouped read beside it. Rejected: the two helpers would hold the same count rule two times.

### D3. One bounded read of the synthesis record, beside its writer

The bounded text read of the snapshot pin moves into `src/execution/run-synthesis.ts`, beside `persistSynthesis`. One file-name constant serves the writer and the readers. The read takes the workspace root and the run id, and it refuses an id that `isSafeId` refuses. The pin keeps its lenient parse of the text.

`readRunSynthesis({ workspaceRoot, runId })` reads the text and parses the JSON. Then it validates the JSON with `RunSynthesisSchema`, and it gives `flattenDataPart(buildRunSynthesisPart(runId, synthesis))`. Thus the read and the run stream give one shape from one builder. The read gives `Promise<RunSynthesisPart | null>` with no error channel. Each fault degrades to `null`, the rule of the pin for an absent, unreadable, or oversized record.

The flatten gives a plain record. Thus the result type comes from a type assertion with a comment: the payload comes from a validated `RunSynthesis`, and the builder sets each field of the part. A test parses the result with `RunSynthesisPartSchema`. A parse with that schema would also strip `translationalRelevance`, and then the read would differ from the stream part.

The read does not read the run row, and the embedder gates on the recorded outcome. The embedder also resolves the workspace root, as it does for `persistSynthesis`.

### D4. The contract finding gets `references`

`src/contracts/chat-parts.ts` gets a reference type with `pmid`, `citation`, `relevance`, and `concordance`, and `SynthesizedFinding.references` uses it. `src/contracts/schemas/chat-parts.ts` gets the same field in `SynthesizedFindingSchema`. The contract modules keep no import from `src/schemas/`, because a client imports the contracts alone.

The field is required. The stored schema requires `references` on each finding, and the stream part carries the stored findings. Thus each flat part that the harness writes already has the field.

### D5. Root exports

`src/index.ts` exports `queryArtifactPage`, `countArtifactsByRuns`, `readRunSynthesis`, and the types of their query and entries. `src/state/index.ts` changes `countArtifactsForRun` to `countArtifactsByRuns`. The precedent is the grouped reads of `analysis-summary-reads`.

### D6. Two spec trees

This change holds the harness deltas and code. The companion cli change with the same name holds the routes, the wire types, and the `local-server` delta.

## Risks / Trade-offs

- [The list read cost grows with the ledger of one analysis] → The user accepted it. A later trigram index can serve `q` with no change to the read contract.
- [`created_at` is the first registration of a path] → The sort `recent` orders by the first registration. A path that a later run writes again keeps its first time.
- [**BREAKING** `references` is required in the contract schema] → Each flat synthesis part that the harness writes has it. A nested part from before the flat stream fails the schema already.
- [`lower()` follows the collation of the database] → The match is case-insensitive for the characters that the collation folds.
