# Design

## Context

See `proposal.md` for the motivation. The harness change of the same name gives the run reads and the thread read.

- `GET {A}/asks` (`src/server/routes/conversation.ts`) calls `askGateway.pending()`, which reads each pending ask of each analysis in one statement, and filters in memory. #644 counts the same result for the analysis list.
- The turn registry (`src/server/turns.ts`) holds each running turn in process memory. It gives no running turn of a thread. The server does not serialize turns, thus a thread can have more than one running turn.
- `RUN_IS_LIVE` (`src/server/durable_work.ts`) is the one liveness rule of a run. Its text binds the live workflow statuses as `$2`. The busy gate, the stop activity, and the analysis list read it through `countLiveDurableWork` and `countLiveDurableWorkByAnalysis`. A parallel change (#633) can change the run status set in that text.
- `toThreadSummary` (`src/server/routes/conversation.ts`) is the one producer of a `ThreadSummary`. `GET {A}/threads`, `GET {T}`, `PATCH {T}`, and `POST {T}/restore` use it.
- The name of an analysis is in SQLite only. Postgres has no name.
- `_migrations` records the time of each migration, but a later squash of the migrations into a baseline can lose that row.

## Goals / Non-Goals

**Goals:**

- A fixed count of reads for one attention request: 5 Postgres reads at most and 2 SQLite reads.
- One liveness rule and one plan title and step count rule.
- A seen state that survives a restart of the server.

**Non-Goals:**

- No client fetcher and no TUI change. The consumer is the GUI.
- No change to the liveness rule, to `countLiveDurableWork`, or to `countLiveDurableWorkByAnalysis`.
- No change to `GET {A}/asks` or `GET {A}/runs`.
- No seen state for a data profile.
- No activity time for a seen mark.

## Decisions

### The route composes the reads behind an options object

`attentionRoutes(boot, opts)` in `src/server/routes/attention.ts` mounts at `/api/v1/attention` in `app.ts`, behind `requireRuntime`. An `AttentionRouteOpts` options object holds each read that a test replaces:

- the pending asks: `runtime.askGateway.pending()`
- the live runs: a new `listLiveRunIds(pool, limit)` in `durable_work.ts`
- the progress of the live runs: `queryRunProgressByRuns` of the harness
- the ended runs: `queryRunsEndedSince` of the harness
- the newest threads: `createThreadStore(pool).listRecentThreads`
- the seen baseline: `getRunSeenBaseline`
- the seen marks of a list of runs: `listSeenRunIds`
- the names: `listAnalysisNames`
- the running turns: `runningTurnsByThread` of the turn registry

The pending asks, the live runs, the ended runs, and the newest threads start together. The two run reads are not one snapshot. A run that ends between the live-run read and the progress read has a terminal status in the progress entry, and `activeRuns` leaves it out. It can then be in `unseenRuns` of the same response, which is correct. The progress read waits for the live run ids. The names read waits for each list, and it takes the union of their analysis ids. A failed read gives 500 `internal_error`. Each list reads Postgres. A list that degrades to `null` hides the same fault that a 500 shows, and a 500 keeps the item shape fixed.

### The live runs use the liveness rule as it is

`listLiveRunIds(pool, limit)`:

```sql
SELECT r.run_id FROM cortex_runs r
 WHERE ${RUN_IS_LIVE}
 ORDER BY r.started_at DESC, r.run_id DESC
 LIMIT $1
```

`$1` is the limit, 200, and `$2` stays the live workflow statuses. The text of `RUN_IS_LIVE` does not change, thus a change of its status set by #633 applies to the list with no merge of two rules. Only the doc of the constant names the new reader.

The progress of the runs then comes from `queryRunProgressByRuns`. Thus `activeRuns` costs two statements, not one: the liveness rule is in the cli, and the progress SQL is in the harness. A single statement would copy one of the two rules. A move of the liveness rule into the harness changes the busy gate, and #633 can change the same text.

### The seen state is a mark table and a baseline row

Migration 12:

```sql
CREATE TABLE run_seen_marks (
    run_id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL,
    analysis_id TEXT NOT NULL REFERENCES analyses(id) ON DELETE CASCADE
);
CREATE INDEX idx_run_seen_marks_analysis ON run_seen_marks(analysis_id);
CREATE TABLE run_seen_baseline (since INTEGER NOT NULL);
INSERT INTO run_seen_baseline (since)
  VALUES (CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER));
```

The baseline row is the time of "this change" on this machine. A read of `_migrations.applied_at` was rejected, because a squash of the migrations can lose that row. The run id is the identity of a mark, `seen_at` is its time, and `analysis_id` is its foreign key, in the house order. The cascade removes the marks of a deleted analysis. Its Postgres runs go with the purge of the delete.

`unseenRuns` reads `getRunSeenBaseline()`, then calls `queryRunsEndedSince`. It gives `since` as `new Date(since).toISOString()` and a limit of 200. After the ended-run read, `listSeenRunIds` reads the marks of exactly the ids of that page, in one statement. `unseenRuns` is that page minus the seen ids. Thus each poll costs one bounded Postgres read and one bounded SQLite read, whatever the count of marks. A skip list of each mark in the ended-run read was rejected, because the marks only grow and a client polls each 5 to 15 seconds. When the baseline row is absent, the route gives an empty `unseenRuns` and logs a warning. A read on a passive request does not write the row again (cli `CLAUDE.md`, "Local state can go out of agreement").

A list fed by the bus event `prov.run_completed` was rejected. The start failure of `execute_analysis` and the external cancel stamp a terminal status with no such event, thus that list would miss those runs.

### The seen route checks the run

`POST /run/:runId/seen` in `runRoutes` reads the run with `opts.getRun`. It gives 404 `not_found` for an absent run or a run of a different analysis, the same as the cancel route. It gives 409 `conflict` with "The run has not ended." for a status that is not terminal. Then it calls `recordRunSeen(runId, analysisId, Date.now())` and answers `{ seen: true }`. `RunSeenResponse` goes into `src/api/runs.ts`.

### The names come from one SQLite read, and an orphan item drops

`listAnalysisNames(ids)` gives the ids as one JSON array parameter to `json_each`, thus the list can pass the SQLite ceiling of bound parameters. An item whose analysis id has no row drops from its list. The analysis guard gives 404 for such an id, thus the person cannot open it. This keeps `analysisName` a `string`, as the issue gives it.

### The thread fields come from the registry and one ask read

`turns.ts` gains `runningTurnsByThread()`: a `Map` from each thread id with a running turn to the id of its newest running turn. The newest turn has the latest `startedAt`, and the greater turn id breaks a tie. `listThreadTurns` uses the same start order, and a UUIDv7 turn id sorts by its start. `toThreadSummary(thread, extras)` takes `{ runningTurnId, pendingAsks }`. A route counts the pending asks by `threadId` from one `askGateway.pending()` call:

- `GET {A}/threads`, `GET {T}`: the ask read and the thread read start together.
- `PATCH {T}`, `POST {T}/restore`: the ask read runs before the write. A failed read gives 500 and writes nothing.

`ThreadSummary` gains `runningTurnId: string | null` and `pendingAsks: number`. Each fixture that builds a `ThreadSummary` gets the two fields.

### The wire types

`src/api/attention.ts` holds `AttentionAsk`, `AttentionActiveRun`, `AttentionUnseenRun`, `AttentionThread` (`ThreadSummary & { analysisName: string }`), and `Attention`. `status` of an unseen run is `TerminalRunStatus` of the harness. `limit` uses the validity rule and the cap of `perPage` in `parsePage`, with its own default: a value that is not a positive integer selects 10, and a larger value than 200 selects 200. A call of `parsePage` as it is would give its default of 100.

## Risks / Trade-offs

- [`unseenRuns` holds the unseen runs among the newest 200 ended runs since the baseline. An unseen run that is older than that window is absent] → The cost of a poll stays fixed. An unseen run leaves the window only after 200 newer runs end.
- [An ask is not stale while a newer turn of its thread runs. The turn of the ask can be over] → The ledger records no turn of an ask. The issue defines `stale` by the thread.
- [`activeRuns` costs two Postgres statements] → The count stays fixed, and each rule keeps one copy.
- [A failed read hides all four lists] → The route is a read of Postgres. A client reads it again at its next poll.
- [A run row that is not terminal and has no live workflow is in neither run list] → The busy gate reads such a row the same way: a crashed host leaves it. The local run charge never suspends a run for funds.
- [A rename or a restore of a thread fails with 500 when the ask read fails] → `ThreadSummary` is the body of those routes, and the issue gives it the two fields. The read runs before the write, thus the failure changes nothing.

## Migration Plan

Migration 12 is forward-only and additive. An older binary ignores the two tables. A run that ended before the migration counts as seen.
