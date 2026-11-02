# Design

## Context

`GET {A}/paused-work` (`src/server/routes/paused_work.ts`) calls `work.list(analysisId)` of the runtime. It keeps the work that waits, adds the remedy of the cause `credential`, and pages the items with `parsePage` and `listEnvelope` (`src/server/http.ts`). The wire types are in `src/api/paused_work.ts`. `PausedWork` is the harness `Work` with an optional `remedy`, and `Work` already carries `analysisId`.

The harness change `name-and-time-the-waits-of-paused-work` gives `PausedWorkflow` an optional `waiter`. `WorkSurface.list` takes an optional analysis id, and with no id it gives the active work of each analysis. A `data-pause` part now has a required `cause` and `pausedAt`, and the end part adds `endedAt` and `end`. The route passes each `Work` through, thus `GET {A}/paused-work` already gives the waiter. Only the spec and the tests do not state it.

The attention read (`src/server/routes/attention.ts`) is the one route that reads work over each analysis. It drops an item whose analysis has no SQLite row, through `listAnalysisNames` (`src/db/primary_query.ts`), and its tests replace that read through `AttentionRouteOpts`.

The cli reads the harness from npm. `bun run harness:local` builds the working-copy harness and links it into `node_modules`, thus the typecheck and the tests see the new contract.

## Goals / Non-Goals

**Goals:**

- One request gives the paused work of each analysis, in the item shape of `GET {A}/paused-work`.
- The two list routes share one code path for the filter, the remedy, and the page.
- The cli typecheck and the cli tests pass against the working-copy harness.

**Non-Goals:**

- A client fetcher or a TUI change. No cli client calls the new route. The TUI keeps its read of `GET {A}/paused-work` in its poll.
- A display of the waiter, `pausedAt`, `endedAt`, or `end` in the TUI.
- An `analysisName` field on an item. The issue asks for the item shape of `GET {A}/paused-work`.
- An order of the items. `GET {A}/paused-work` states no order, and the new route keeps the order of `work.list`.

## Decisions

- **A second route function in `src/server/routes/paused_work.ts`.** `pausedWorkCollectionRoutes(boot, opts)` gives `GET /`, and `src/server/app.ts` mounts it at `/api/v1/paused-work`, beside the attention mount. The analysis guard does not cover that path. The name obeys `analysisCollectionRoutes`. To mount `pausedWorkRoutes` a second time is the alternative, but it also mounts the resume and the hold with no analysis id. To add a list to the attention read is a different alternative, but the issue names a separate route with the list fields.
- **One list function serves the two GET routes.** It takes the analysis id or no id, and it calls `work.list` one time. It keeps the work whose `waiting` is not empty, adds the remedy, and pages the items. Before the page, the collection route drops the work of an analysis with no row. Thus `total` counts only the items that a client gets. The function stays in the same file, because only these two routes call it.
- **The rows of the analyses come from `listAnalysisNames`.** `PausedWorkRouteOpts` gets `analysisNames`, with the default `listAnalysisNames`. The route keeps an item when the map has its analysis id. Thus a test gives the rows with no SQLite file, the same as `AttentionRouteOpts.analysisNames`. `listAnalysisNames` sends no statement for an empty list, thus a server with no paused work does no SQLite read. A failed read gives 500 `internal_error`, with the message "read the analysis names".
- **The rule for an analysis with no row obeys the attention read.** No `{A}` route can resume, hold, or stop the work of such an analysis, because the analysis guard answers 404. The busy gate refuses a delete of an analysis while its turn, run, or profile is live. Thus only a SQLite file that the user changed reaches this case.
- **The wire types do not change.** The new route gives `PausedWorkList`. The doc comments of `src/api/paused_work.ts` name the new route.
- **The fixtures obey the new contract with real values.** Each `data-pause` frame and part of a test carries `cause` and `pausedAt`. A frame in the state `running` also carries `endedAt` and `end`: `resume`, or `abort` for a turn that a stop ends. The fake `WorkSurface.list` of `src/server/routes/paused_work.test.ts` gives each item when the analysis id is absent.
- **The fixture fixes touch four test files.** These files are `src/server/routes/paused_work.test.ts`, `src/tui/hooks/pauses.test.ts`, `src/tui/hooks/conversation.test.ts`, and `src/server/routes/conversation.test.ts`. The last file passes today, but its frame is not valid under the new contract.
- **The spec names `work.list`, `work.resume`, and `work.hold`.** The spec of the paused-work routes names `pausedWork.*`, but the runtime gives `CoreRuntime.work`. This fix is outside the issue. It is a stale reference in the requirements that this change modifies.

## Risks / Trade-offs

- [Work that changes between two pages can show an item two times, or not at all] → `GET {A}/paused-work` has the same limit. The default page holds 100 items, and the count of paused work is small.
- [The work of an analysis with no row stays out of each list] → No route can act on that work. The busy gate prevents the case through the API.
