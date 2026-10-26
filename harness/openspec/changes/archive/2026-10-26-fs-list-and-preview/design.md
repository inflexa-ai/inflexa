# Design

## Context

- `cortex_artifacts` has the primary key `(analysis_id, path)` (`src/state/migrations/20260927120000_baseline.ts:55-67`). `path` is relative to the workspace root of the analysis. `source_run` and `source_step` are `NULL` for an `input` row.
- `queryInputArtifacts` (`src/state/artifacts.ts:138-160`) and `countArtifactsByRuns` (`:387-399`) take a list with `= ANY($2::text[])` in one statement. `countArtifactsByRuns` sends no statement for an empty list.
- `src/state/index.ts:14-27` and `src/index.ts:610-612` export the artifact list reads. `src/state/test/artifact-reads.barrel.test.ts` pins the exports of the package root.

## Goals / Non-Goals

**Goals:**

- One statement gives the origin of each path of one page of the cli folder list.

**Non-Goals:**

- No cap on the length of the list. The caller bounds it. The cli sends at most one page of 200 paths.
- No filter by role. The caller reads the run and the step, and an `input` row has neither.

## Decisions

### D1. `queryArtifactOrigins` is one `= ANY` statement

```sql
SELECT path, source_run, source_step
FROM cortex_artifacts
WHERE analysis_id = $1 AND path = ANY($2::text[])
```

The read is `queryArtifactOrigins(pool: Querier, analysisId: string, paths: readonly string[]): ResultAsync<ArtifactOrigin[], DbError>`. The type `ArtifactOrigin` is `{path: string; runId: string | null; stepId: string | null}`. A path with no row has no entry. An empty list gives `[]` and sends no statement. The order of the entries is not part of the contract, because the caller maps them by path.

The lookup uses the primary key, thus its cost grows with the length of the list and not with the ledger.

Alternative: extend `queryArtifactPage` with a list of paths. That read sends two statements and computes the extension counts, and the caller wants neither. Rejected.

Alternative: extend `queryInputArtifacts`. Its contract is the `input` rows, with the hash and the file id. Rejected.

### D2. The exports

`src/state/index.ts` exports `queryArtifactOrigins` and the type `ArtifactOrigin`. `src/index.ts` exports them beside `queryArtifactPage`. The barrel test pins them.

## Risks / Trade-offs

- [A very long list makes one large statement] → The cli caller sends at most one page. The read states that the caller bounds the list.
