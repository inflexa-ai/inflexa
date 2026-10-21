# Design

## Context

- `GET {A}/runs` reads `page`, `perPage`, `active`, and `threadId` (`src/server/routes/runs.ts:220-229`). `listRunPage` has three branches (`:587-602`):
  - `active=true` reads each running run and pages the rows in memory.
  - `threadId` reads one row past the page, and `total` is a lower bound.
  - The default reads the page with `queryRunsByAnalysis` and the count with `queryRunsForInspection` at a limit of 0 (`:180-186`).
- `summarizeRuns` reads the plan title after the page (`src/server/routes/runs.ts:617-653`). Thus the route cannot filter by the title.
- `RunRoutesOpts` gives each harness read to the route, and the tests replace the reads (`src/server/routes/runs.ts:110-155`).
- `GET {A}/artifacts` reads its filters with `filterValue`, a private function of `src/server/routes/artifacts.ts:40-43`. An absent or empty value is no filter. The route returns `listEnvelope("artifacts", …)` (`:63-86`).
- `ArtifactList` is `ListEnvelope<"artifacts", ArtifactEntry>` (`src/api/artifacts.ts:62-63`). The list rule of the spec lets a list add a field that its own requirement names.
- The harness change gives `q` on `queryRunsByAnalysis`, `queryRunsByThread`, and `queryActiveRunsByAnalysis`, and the new `countRunsByAnalysis`. It gives `path`, `extensions`, and `extensionCounts` on `queryArtifactPage`.

## Goals / Non-Goals

**Goals:**

- The routes give the new filters to the harness reads, and the harness does each filter.
- The input of the new query values enters the system in the route, one time.

**Non-Goals:**

- No client fetcher in the cli. `fetchRuns` gets no `q`, because no cli surface searches the runs. The cli has no fetcher of the artifact list.
- No kind of file (figure, table) on the server. Flamme maps an extension to a kind (himmel `apps/flamme/src/data/files.ts`). The `fileType` filter keeps its folder meaning.
- No exact `total` for `threadId`.

## Decisions

### D1. `filterValue` moves to `src/server/http.ts`

The runs route needs the rule of `filterValue` for `q`. Thus the function gets a second caller. It moves to `src/server/http.ts` as an export, beside `parsePage`, and the artifacts route imports it.

### D2. `q` reaches each branch of the run list

The route reads `q` with `filterValue`, and `listRunPage` gives it to the read of each branch. The read types of `RunRoutesOpts` become:

- `listRuns(pool, analysisId, query: { q?: string; limit: number; offset: number })`
- `listThreadRuns(pool, analysisId, threadId, query: { q?: string; limit: number; offset: number })`
- `listActiveRuns(pool, analysisId, filter: { q?: string })`

The default `listRuns` combines `queryRunsByAnalysis` with `countRunsByAnalysis`, each with the same `q`. It no longer reads `queryRunsForInspection`. The `active` branch still pages in memory. Its read gives only the running runs that `q` selects, thus `total` counts them. The order of the branches stays as it is: `active=true` comes first, and it ignores `threadId`.

Alternative: refuse `q` beside `active` or `threadId` with 400. Each filter of the artifact list combines with AND, and the run list obeys the same rule.

Alternative: filter the page after `summarizeRuns`. The page then holds fewer runs than `perPage`, and `total` is wrong.

### D3. The route normalizes the extension list

The route reads `extension` with `filterValue`. Then it splits the value at each comma. It removes the spaces at the start and the end of each member, puts each member in lower case, and drops each empty member. A list with members goes to the read as `extensions`. An empty list goes nowhere, thus the read selects each row. The harness compares the members as they are, because the route gives them in lower case.

The value is one query value with commas, not a repeated key. The other filters of the route are single values, and `c.req.query` reads one value.

### D4. `path` passes as it is

The route reads `path` with `filterValue` and gives it to the read as `path`. Case is significant, and the route changes nothing in the value.

### D5. The wire type of a count

`src/api/artifacts.ts` gets `ArtifactExtensionCount = { extension: string | null; count: number }`. `ArtifactList` becomes `ListEnvelope<"artifacts", ArtifactEntry> & { extensionCounts: ArtifactExtensionCount[] }`. The route maps each harness entry to the wire type, the same as it maps each row (`src/server/routes/artifacts.ts:84`).

### D6. The JSDoc tells the new values

The JSDoc of `RunList` names `q` and its effect on `total`. The JSDoc of `ArtifactList` names `extensionCounts`. The JSDoc of `artifactRoutes` keeps its cost note, because the count still reads each selected row.

## Risks / Trade-offs

- [A member of `extension` with a dot, for example `.png`, matches nothing] → It obeys the rule of `fileType`, whose unknown value also selects no row. The spec defines an extension as the text after the last dot, thus no extension holds a dot.
- [`q` with `threadId` keeps the lower-bound `total`] → The `RunList` contract already states it.
