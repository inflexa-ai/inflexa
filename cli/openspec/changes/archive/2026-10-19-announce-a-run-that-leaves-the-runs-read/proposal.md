# Announce a run that leaves the runs read

## Why

The completion watcher announces a run only when the runs read shows the run terminal. That read holds the active runs and the newest `RUNS_LIMIT` (10) runs of the open analysis. A run can end after ten newer runs started. Then it is in neither list, thus no read shows it terminal, and the user never gets its notice.

The abort of issue #250 works around this gap for its own case: it raises its own notice when the canceled run is not in the runs read. A normal completion still has no notice.

## What Changes

- The watcher remembers the analysis of each run that it saw non-terminal. When a successful runs read of that analysis does not hold such a run, the watcher reads the run by its id with `GET {A}/run/:runId`.
- A terminal status from that read announces the run, with the same keying as a terminal status in the runs read. A non-terminal status keeps the run, and the next runs read that misses it reads it again. A `not_found` drops the run with no notice. A failed read raises no notice and keeps the run.
- The watcher starts at most one read of a run at a time, and it reads no run of an analysis that is not open.
- A loaded runs snapshot names the analysis that it belongs to.
- The abort no longer raises its own notice for a canceled run outside the runs read. The watcher announces that run, as it announces each other run. `markRunAnnounced` and the two abort edges that use it go.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `run-completion-notice`: a run that leaves the runs read is read by its id and announced. The coverage statement of the keying requirement is corrected.
- `local-server`: a poll tick also reads each run that the TUI saw active and that the runs read no longer holds.
- `activity-panel`: the abort leaves the announcement of a canceled run to the run-completion notice in each case.

## Impact

- `src/tui/hooks/run_completion.ts`: the read of a run that left the runs read, its injectable read, and the removal of `markRunAnnounced`.
- `src/tui/hooks/sidebar_live.ts`: the loaded `RunsSnapshot` carries `analysisId`.
- `src/tui/hooks/activity_panel.ts`: the abort loses its own notice branch and the `readRuns` and `markAnnounced` edges.
- Tests: `src/tui/hooks/run_completion.test.ts`, `src/tui/hooks/activity_panel.test.ts`, `src/tui/hooks/sidebar_live.test.ts`.
- No server change. The route `GET {A}/run/:runId` exists.
