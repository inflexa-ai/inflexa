# Design

## Context

- `queryRunsByAnalysis`, `queryRunsByThread`, and `queryActiveRunsByAnalysis` select the columns of `cortex_runs` only, ordered by `started_at DESC` (`src/state/runs.ts:193-207`, `:319-336`, `:447-465`). No read counts the runs in that order. The cli gets its count from `queryRunsForInspection` with a limit of 0 (`cli/src/server/routes/runs.ts:180-186`).
- A run row holds `plan_id`, not the plan title. The title is the optional `title` member of the JSONB document `cortex_plans.plan` (`src/state/migrations/20260927120000_baseline.ts:121-131`). The primary key of `cortex_plans` is `plan_id`. The run foreign key sets `plan_id` to null when its plan goes away (`baseline.ts:514`).
- `queryArtifactPage` builds AND conditions on bound values, and it sends a `COUNT(*)` statement and a page statement (`src/state/artifacts.ts:288-338`). The `q` filter uses `strpos(lower(path), lower($n::text)) > 0`, because `LIKE` would make `%` and `_` wildcards (`:299-300`).
- The primary key of `cortex_artifacts` is `(analysis_id, path)` (`baseline.ts:53-61`). No index serves a function of the path.
- `file_type` comes from the folder of a file (`src/schemas/artifact-manifest.ts:33-46`). Flamme takes the kind of a file from the extension of its name (himmel `apps/flamme/src/data/files.ts`). Its rule for the extension is the rule of the delta spec of `artifact-manifest`.
- The root barrel exports `queryRunsByAnalysis`, `queryActiveRunsByAnalysis`, `queryArtifactPage`, and the artifact page types (`src/index.ts:601-603`, `:785-798`). The cli imports `queryRunsByThread` and `queryRunsForInspection` from the deep path `state/runs.js`.

## Goals / Non-Goals

**Goals:**

- A text filter of the runs that applies before the window, thus a page and a count of the filtered runs are exact.
- An exact-path filter that uses the primary key.
- An extension filter and a count of each extension, with no third statement in the paged read.

**Non-Goals:**

- No kind vocabulary (figure, table) in the harness. The consumer maps the extensions to its kinds.
- No migration and no new index.
- No change of the order of a read.
- No filter for the rows with no extension. A consumer gets their count from `extensionCounts`.

## Decisions

### D1. One text condition for the run reads

A private function of `src/state/runs.ts` gives the condition for a bound placeholder `$n`:

```sql
(strpos(lower(run_id), lower($n::text)) > 0
 OR EXISTS (SELECT 1 FROM cortex_plans p
            WHERE p.plan_id = cortex_runs.plan_id
              AND p.analysis_id = cortex_runs.analysis_id
              AND jsonb_typeof(p.plan -> 'title') = 'string'
              AND strpos(lower(p.plan ->> 'title'), lower($n::text)) > 0))
```

`queryRunsByAnalysis`, `queryRunsByThread`, `queryActiveRunsByAnalysis`, and `countRunsByAnalysis` add it to their `WHERE` with AND when `q` is present. Without `q`, each read sends the statement that it sends now. The `EXISTS` reads one plan through its primary key. The `analysis_id` condition keeps the plan of a different analysis out, the same scope as `loadPlan`.

Alternative: a `LEFT JOIN` of `cortex_plans`. Each read then qualifies its column list, and a change of the join can duplicate a row.

Alternative: a filter in the host, after the page. The page then holds fewer runs than its size, and the count is wrong. This is the gap of #692.

Alternative: a title column on `cortex_runs`. It needs a migration and a write at each run start, for a value that the plan already holds.

### D2. A dedicated count of the runs

`countRunsByAnalysis(pool, analysisId, { q? })` gives `ResultAsync<number, DbError>` from one `SELECT COUNT(*)::int` statement with the condition of D1. The root barrel exports it beside `queryRunsByAnalysis`.

Alternative: a `q` on `queryRunsForInspection`. That read has the order of the `inspect_run` tool, and it sends a page statement that a count does not need.

Alternative: a `RunPage` result for `queryRunsByAnalysis`. The report pin pages that read (`src/report-model/pin-snapshot.ts:182`), and it does not need a count.

### D3. The exact path uses the primary key

`ArtifactPageQuery` gets `path?: string`. With it, the read adds `path = $n`. The condition and `analysis_id = $1` select through the primary key.

### D4. One extension expression for the filter and the count

`src/state/artifacts.ts` holds one SQL expression for the extension of `path`:

```sql
lower(substring(regexp_replace(path, '^.*/', '') from '^.+\.([^.]+)$'))
```

`regexp_replace` removes the folders. The pattern matches only a name with one character or more before its last dot, and one or more after it. Thus each name with no extension gives `NULL`.

`ArtifactPageQuery` gets `extensions?: readonly string[]`. A list with members adds `<expression> = ANY($n::text[])`. An absent or empty list adds nothing. The read compares the members as they are. The host gives them in lower case, because the host is where the input enters.

### D5. The count statement groups by the extension

The count statement becomes:

```sql
SELECT <expression> AS extension, COUNT(*)::int AS n
FROM cortex_artifacts WHERE <conditions>
GROUP BY 1 ORDER BY 1 ASC NULLS LAST
```

`total` is the sum of `n`. `extensionCounts` maps each row to `{ extension, count }`. Thus the read still sends two statements, and a page past the end still has its counts.

`ArtifactPage` gets `extensionCounts: ArtifactExtensionCount[]`, with `ArtifactExtensionCount = { extension: string | null; count: number }`. The root barrel exports the type.

Alternative: a third statement for the counts. It breaks the bound of two statements.

Alternative: a window count in the page statement. A page past the end has no row to carry it, the reason for the separate count statement now.

## Risks / Trade-offs

- [The text filter of the runs reads the plan of each run of the analysis] → Each read is one primary-key lookup. The cost grows with the runs of one analysis, the same as the count of the runs grows now.
- [The extension expression runs on each selected row of the count] → The count already reads each selected row. The expression adds work on the processor, not reads of the disk. The read stays inside one analysis through the primary key.
- [The title match uses the raw title. The cli shows the trimmed title] → Only a text with a space at its start or its end can match differently.
- [`extensionCounts` is a required member of `ArtifactPage`] → A test double of a host must give it. The cli does this in its companion change.

## Migration Plan

No migration. The reads use the existing primary keys.
