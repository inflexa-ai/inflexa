# Tasks

## 1. The loaded runs snapshot names its analysis

- [x] 1.1 In `src/tui/hooks/sidebar_live.ts`, add `analysisId: string` to the `loaded` member of `RunsSnapshot`, and set it in `refreshSidebarData`. Update each test that builds a loaded runs snapshot (`src/tui/hooks/sidebar_live.test.ts`, `src/tui/hooks/activity_panel.test.ts`). Make sure that `bun test src/tui/hooks/sidebar_live.test.ts` passes.

## 2. The watcher reads a run that left the runs read

- [x] 2.1 In `src/tui/hooks/run_completion.ts`, add `RunCompletionOpts` with `loadRun(analysisId, runId)` and `DEFAULT_RUN_COMPLETION_OPTS` (real: `fetchRun`), and make `watchRunCompletions(opts = DEFAULT_RUN_COMPLETION_OPTS)` take it. Add the analysis to `LastKnownRun`.
- [x] 2.2 After the loop over a loaded snapshot, find the vanished runs: each run of `seenActive` with the analysis of the snapshot that the snapshot does not hold. Read each vanished run that has no open read, while fewer than 4 reads are open. Keep a set of the open reads. When a read resolves:
  - a terminal status announces only when three conditions are true. The run is still in `seenActive`. Its key is not in `reacted`. Its analysis is the analysis of the newest loaded snapshot, read with `untrack`. Then add the key to `reacted` and delete the run from `seenActive`, as the loop does. If a condition fails, raise nothing
  - a non-terminal status keeps the run
  - an `http` error with the status 404 drops the run from `seenActive` with no notice
  - each other error keeps the run.

  Clear the set of the open reads in `__resetRunCompletionsForTest`.
- [x] 2.3 Remove `markRunAnnounced` and its tests in `src/tui/hooks/run_completion.test.ts`.
- [x] 2.4 In `src/tui/hooks/run_completion.test.ts`, add a test for each scenario of the requirement "A run that leaves the runs read still announces its end". Use a fake `loadRun`, and drive the snapshot with `refreshSidebarData` and the existing `optsFor` pattern. Assert on the notices and on the reads that the fake received. Make sure that `bun test src/tui/hooks/run_completion.test.ts` passes.

## 3. The abort leaves the announcement to the watcher

- [x] 3.1 In `src/tui/hooks/activity_panel.ts`, remove the branch of `abortFocusedRun` that raises its own "was canceled" notice when the snapshot does not hold the run. Remove the `readRuns` and `markAnnounced` edges from `RunAbortOpts` and `DEFAULT_RUN_ABORT_OPTS`. Keep the warning notice for a ledger that did not settle, and keep the refresh.
- [x] 3.2 Update `src/tui/hooks/activity_panel.test.ts`: a canceled run outside the refreshed runs gets no notice from the abort. Add one test that runs the abort and the watcher together: a canceled run outside the refreshed runs gets exactly one "was canceled" notice, from the watcher. Make sure that `bun test src/tui/hooks/activity_panel.test.ts src/tui/app_activity_panel.render.test.tsx` passes.

## 4. Verification

- [x] 4.1 Run `bun run format:file` on each changed file in `src/`, then `bun run typecheck` and `bun run lint` in `cli/`. The typecheck has 3 known errors from the stale installed `@inflexa-ai/prov-kernel` in untouched files. Make sure that lint passes and that no new typecheck error appears.
- [x] 4.2 Run `bun test src/tui/hooks/run_completion.test.ts src/tui/hooks/sidebar_live.test.ts src/tui/hooks/activity_panel.test.ts src/tui/app_activity_panel.render.test.tsx src/tui/keymap_chord_uniqueness.render.test.tsx`. Make sure that they pass.
- [x] 4.3 Run the full cli suite one time with `bun run test`. Make sure that it passes, or record each failure with its cause.

## 5. Review corrections

- [x] 5.1 Rotate a run whose by-id read gives a non-terminal status or a kept error to the back of `seenActive`, so that each waiting run gets a read in turn under the width of 4. Do the move in the read callback, not inside the scan loop. Add a test for the scenario "Waiting runs get a read in turn", and make sure that it passes.
- [x] 5.2 When a terminal status meets a key that already has a reaction, drop the run from `seenActive`, in the loop over the snapshot and in the read callback. Add a test for the scenario "An announced run is not read again" that counts the later reads, and make sure that it passes.
- [x] 5.3 Add a comment to each new `!` assertion in `src/tui/hooks/run_completion.test.ts` (near lines 90 and 433) that states why it is safe, per `cli/CLAUDE.md`.
