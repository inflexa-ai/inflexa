# Design

## Context

See `proposal.md` for the problem. The harness change with the same name gives three reads: `queryArtifactPage`, `countArtifactsByRuns`, and `readRunSynthesis`. Its `design.md` records the cost of the ledger read: the cost grows with the ledger of one analysis, by the decision of the user.

These cli facts shape the approach:

- `artifactRoutes()` takes no boot and has no runtime gate (`src/server/routes/artifacts.ts:35-48`). `POST {A}/artifacts/resolve` reads SQLite and the disk only.
- `RunRoutesOpts` holds each harness read of the run routes, and a test replaces each one (`src/server/routes/runs.ts:80-146`). `summarizeRuns` reads the extra figures of a page in a fixed count of reads, and a failed figure read costs that figure only (`src/server/routes/runs.ts:424-452`).
- The analysis list refuses a bad `sort` with 400 `validation_error` (`src/server/routes/analyses.ts:236-240`).
- `GET {A}/files` has no client fetcher, because its consumer is the web client.
- `workspaceRootForAnalysisId` resolves the workspace folder of an analysis (`src/modules/analysis/output.ts:180`).

## Goals / Non-Goals

**Goals:**

- One harness read for each request of the artifact list, and one count read for each page of runs.
- The synthesis of a run with no replay of the run stream.

**Non-Goals:**

- No client fetcher, and no TUI surface. No TUI view shows the count or the list.
- No validation of `fileType` against a set of types.

## Decisions

### D1. The artifact list route

`artifactRoutes(boot, opts)` takes the boot and an options object with `listArtifacts`, the harness page read by default. Only `GET /` uses `requireRuntime(boot)`. `POST /resolve` keeps no runtime gate. `app.ts` passes the boot.

The route reads `page` and `perPage` with `parsePage`. It calls `listArtifacts` one time with `limit: perPage` and `offset: page * perPage`. It maps each harness entry to the wire type `ArtifactEntry` of `src/api/artifacts.ts`, and it answers with `listEnvelope("artifacts", …)`.

- `runId`, `stepId`, `fileType`, and `q`: an absent or empty value is no filter. This is the rule of the empty `project` of the analysis list.
- `sort`: `path` or `recent`, a zod enum as in `src/server/routes/analyses.ts:168`. A different value gives 400 with the field error under `sort`.
- `fileType` is free text, because the ledger column is free text. An unknown value gives an empty page.

`src/api/artifacts.ts` gets `ArtifactSort`, `ArtifactEntry`, and `ArtifactList`. `role` uses the harness `ArtifactRole` type with a type-only import, as `src/api/runs.ts` does for the run status.

### D2. The artifact count of a run

`RunRoutesOpts` gets `countArtifacts`, the harness grouped count by default. `summarizeRuns` calls it one time with the run ids of the page, for each list mode. `GET {A}/run/:runId` calls it with the one run. `toRunSummary` sets `artifactCount` from the map of the counts, and a run with no entry gets 0. A failed read leaves `artifactCount` absent on each run, and a log line records the failure.

`artifactCount` is optional on `RunSummary`. Thus no fixture that builds a run summary changes.

Alternative: fail the response on a failed count. Rejected: a failed plan read and a failed usage read already cost their figure only.

### D3. The synthesis route

`GET {A}/run/:runId/synthesis` uses the runtime gate. It reads the run row with `getRun`, and it gives 404 for an absent run or a run of a different analysis. `status` and `reason` come from `synthesisStatus` and `synthesisReason` of the row.

The route reads the record only when `status` is `produced`, because the run row is the authority (`harness` `run-synthesis-outcome`, and the gate of `inspect_run`). `RunRoutesOpts` gets `readSynthesis(analysisId, runId)`. Its default reads the analysis row, and it locates the workspace folder with `locateExistingOutputDir`. Then it calls the harness `readRunSynthesis`. An absent analysis row, an unresolved folder, and a folder that does not exist each give `null`.

The read needs no write. `workspaceRootForAnalysisId` refuses a folder that is not writable (`src/modules/analysis/output.ts:93-107`). Thus a record in a folder that became read-only would read as `null`. `locateExistingOutputDir` is the read-only locator, and `src/server/routes/conversation.ts:91` uses it for the same reason. When the outcome is `produced` and the read gives `null`, the route logs a warning with the run id.

The route calls `holdConnection`, because a folder on a hung mount can stop the read for more than 10 s. This is the rule of `GET {A}/files`.

`src/api/runs.ts` gets `RunSynthesisView`: `status` is the harness `SynthesisStatus` or `null`, `reason` is a string or `null`, and `synthesis` is the contract `RunSynthesisPart` or `null`. The two harness types come in with a type-only import.

Alternative: read the file for each status, as the issue text reads. Rejected: a file from a synthesis that later failed would show as a synthesis that the run row denies. A run with no recorded outcome has the same risk.

## Risks / Trade-offs

- [The list route cost grows with the ledger of one analysis] → The user accepted it. The harness design records the reason.
- [A produced record that fails the schema gives `null`] → The warning in the log names the run. The client still gets the outcome and its reason.
- [`artifactCount` absent on a failed read] → A client shows no figure. It does not show a false 0.
