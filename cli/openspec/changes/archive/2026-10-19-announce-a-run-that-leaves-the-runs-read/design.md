# Design

## Context

`refreshSidebarData` (`src/tui/hooks/sidebar_live.ts`) publishes the runs snapshot: the active runs, then the newest `RUNS_LIMIT` runs. The loaded snapshot does not name its analysis. A swap of the analysis resets the snapshot to `not_ready`.

`watchRunCompletions` (`src/tui/hooks/run_completion.ts`) is one effect over that snapshot. It keeps `seenActive` (each run that it saw non-terminal, with its label and step counts) and `reacted` (each `runId:status` that it announced). Both are per process, and `seenActive` spans analyses. A run that a later snapshot does not hold stays in `seenActive`, and nothing reads it again.

The abort (`abortFocusedRun`, `src/tui/hooks/activity_panel.ts`) refreshes, reads the snapshot, and raises its own "was canceled" notice when the snapshot does not hold the run. It calls `markRunAnnounced` so that a later poll does not announce the run a second time.

## Goals / Non-Goals

**Goals:**

- Each run that this TUI saw non-terminal gets its completion notice, also when it leaves the runs read.
- The watcher is the one announcer of a run end, the abort included.

**Non-Goals:**

- A server change. `GET {A}/run/:runId` exists.
- An announcement of a run that this TUI never saw non-terminal.
- A change to the 200-row page of the active read.

## Decisions

**The watcher reads a vanished run by its id.** After its loop over a loaded snapshot, the watcher finds the vanished runs. A vanished run is in `seenActive`, has the analysis of the snapshot, and is not in the snapshot. The watcher reads each one with the existing run read. The refresh already reads each non-terminal run by id, thus the read has a local pattern. A server query for a list of run ids was rejected: it adds a route and a wire type for a read that is zero in the steady state.

**The loaded snapshot names its analysis.** `RunsSnapshot` gets `analysisId` on its `loaded` member, and `refreshSidebarData` sets it. `LastKnownRun` gets the analysis too. Thus the watcher reads only runs of the open analysis, and the read goes to the correct analysis path. A read of the workspace analysis was rejected: the workspace and the snapshot change in different effects, and the snapshot is the value that the watcher compares.

**The read is injectable.** `watchRunCompletions(opts = DEFAULT_RUN_COMPLETION_OPTS)` takes `RunCompletionOpts` with `loadRun(analysisId, runId)`. The real value is `fetchRun`. `App` calls the watcher with no argument, as before. The tests give a fake read.

**One open read for each run, and at most 4 open reads.** A set of run ids holds the open reads. The effect runs each time the snapshot or the progress map changes. Without the set, one tick could start the same read more than one time.

The watcher starts a read only while fewer than 4 reads are open. A vanished run with no free read waits for a later snapshot. A run whose read keeps failing stays in `seenActive`, thus without the width the count could grow over a long session. The live concurrency of an analysis is small, thus 4 reads free the usual case in one tick.

**A second test when the read resolves.** The read is async. The run must still be in `seenActive`, and its `runId:status` key must not be in `reacted`. Thus a recovery, or a runs read that showed the run terminal first, cannot give a second notice. Also, the analysis of the run must be the analysis of the newest loaded snapshot, read with no tracking. A read that resolves after a swap thus raises nothing, and the run stays in `seenActive` for the next read of its analysis.

**The answers of the read.** A terminal status announces with the `LastKnownRun`, as the loop does. A non-terminal status keeps the run, for example when the active read failed and the listing does not hold a live run. An `http` error with the status 404 drops the run from `seenActive`: the row is gone, which is a normal condition for this client. Each other error keeps the run, and a later tick reads it again.

**The abort leaves the announcement to the watcher.** The watcher saw the aborted run as active, because the panel showed it from the same snapshot. After the refresh of the abort, the watcher reads the run by its id if the snapshot misses it, and announces it. Thus the own notice of the abort, the `readRuns` and `markAnnounced` edges, and `markRunAnnounced` have no remaining purpose, and they go. They are unmerged work of issue #250, and nothing else calls them.

## Risks / Trade-offs

- [Each read costs some database reads on the server.] → At most 4 reads are open at one time. In the steady state no read occurs, because a terminal answer removes the run.
- [The notice of an aborted run outside the runs read comes one read later.] → The abort's own notice came before that read. The read starts in the same refresh. The notice text is the full completion text, the same as for a run that the runs read holds.
- [A failed refresh after an abort delays the notice of the canceled run to a later poll.] → The abort's own notice did not wait for a successful read. The watcher announces the run at the first read that succeeds. The cancel result already reached the user as the panel advance.
- [A run can stay in `seenActive` until the process ends.] → This occurs for an observed run of an analysis that the user never opens again. This is the current behavior for such a run. The set holds only runs that this process saw active.
