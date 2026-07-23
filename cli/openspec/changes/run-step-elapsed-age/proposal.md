# Proposal: run-step-elapsed-age

## Why

A running step in the run block shows a static glyph and nothing else — no motion, no age — so a 4–16-minute step (observed range in issue #203's run, including the new `synthesis` ledger row the companion harness change `synthesis-step-ledger-row` introduces) is indistinguishable from a wedged one. The step ledger already carries `started_at` for every running row, and the sidebar already repaints on a 5s poll while a run is active; the one missing piece is rendering the age.

## What Changes

- `RunStepView` carries an optional start time for running steps; both row→view mapping sites (the sidebar-live refresh, the run-detail dialog's step load) populate it from `StepExecutionRow.startedAt`.
- `RunBlock` renders a compact relative age (the `Date.relativeAge` vocabulary) beside a running step row when a start time is present — sidebar embed, run-detail dialog, and gallery exhibit alike. Rows without a start time, and non-running rows, are unchanged.
- The sidebar's age ticks at the existing poll cadence (fresh snapshot objects each tick); the run-detail dialog shows the age elapsed at the moment it was opened, matching the profile dialog's point-in-time precedent.
- The design-gallery run-block exhibit gains a running row with an age, keeping the gallery the source of truth for the new state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sidebar-live`: the active-run progress snapshot's per-step view carries the running step's start time, sourced from the same ledger read.
- `tui-stream-blocks`: the run block's running step rows render a compact elapsed age when a start time is provided.

## Impact

- **Code**: `cli/src/tui/components/run_block.tsx` (render + `RunStepView`), `cli/src/tui/hooks/sidebar_live.ts` (mapping), `cli/src/tui/components/dialog/run_detail_dialog.tsx` (mapping), `cli/src/tui/layout/design_gallery.tsx` + the run mock (exhibit), render tests.
- **No harness change and no new read**: `queryStepsByRun` already returns `startedAt`.
- **Companion**: `harness/openspec/changes/synthesis-step-ledger-row` adds the `synthesis` ledger row this polish makes legible; the two are independent to implement but motivated by the same issue.
