## Why

Live run progress currently renders in a sticky row pinned above the chat input, while the sidebar RUNS section shows only one-line run summaries and its details dialog is a fixed read-only view of the latest run's steps. The user wants run progress to live in the sidebar (under the newest run), the rail to stop being a fixed-height column that can overflow, and a first-class way to *pick* any run and investigate it — searchable, from the palette and from the RUNS section title. Together with the harness's `seed-pending-step-rows` change (which makes the step ledger carry the full DAG), the progress display stops being misleading about upcoming steps.

## What Changes

- **Remove the sticky run-progress row** from the chat column (`run_progress_row.tsx` and its `app.tsx` mount). Accepted trade-off: with the sidebar hidden there is no live progress surface — the run-started card in the stream and the on-by-default sidebar cover the common case.
- **Render active-run progress inside the sidebar RUNS section**: under the newest run's row, the run block's progress bar and bounded step window (fed by the same `activeRunProgress` snapshot), without repeating the run's name — the run row above is the heading. `RunBlock` gains a heading opt-out prop for this embed.
- **Cap the sidebar's recent-runs list at 3** (currently 4).
- **Make the sidebar vertically scrollable** — the RUNS section now grows with the step window, and rail content may overflow short terminals; the rail scrolls instead of clipping.
- **Replace the runs details dialog with a picker → detail flow**: a searchable `SelectDialog` over the analysis's runs (fetched fresh at open, newest-first, capped at 100 — search covers narrowing, no pagination), and on selection a run-detail dialog showing the run's metadata (status, absolute started/completed times, duration, error) plus its full step list through the run block (no step window). The picker stays mounted under the detail dialog, so esc pops back to browsing.
- **New "Show runs" palette command** opening that picker; the RUNS section title click and the existing `ctrl+x r` leader chord open the same picker (replacing the old dialog everywhere).
- **Gallery exhibits updated**: the sticky-row exhibit is removed; the sidebar progress embed, runs picker, and run-detail dialog are showcased.
- Pending/skipped steps from the seeded ledger render through the existing hollow-circle queued view — no new state mapping.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `sidebar-live`: the active-run progress snapshot feeds the sidebar RUNS section (not a chat sticky row); the rail lists 3 runs with progress under the newest; the details flow becomes picker → run-detail with a fresh capped fetch at open.
- `tui-layout`: the chat shell composition loses the sticky run-progress row; the sidebar becomes a vertically scrollable rail.
- `command-palette`: new "Show runs" command requirement (SelectDialog picker → run-detail dialog, shared with the sidebar entry points).

## Impact

- `src/tui/layout/run_progress_row.tsx` — deleted (with its render test).
- `src/tui/layout/sidebar.tsx` — RUNS section gains the progress embed; rail wrapped in a scroll container; 3-run cap.
- `src/tui/components/run_block.tsx` — heading opt-out prop.
- `src/tui/components/dialog/runs_dialog.tsx` — replaced by a runs picker (SelectDialog composition) + a new run-detail dialog.
- `src/tui/app.tsx` — sticky row unmounted; `openRuns` rewired to the picker.
- `src/tui/commands.tsx` — new `runs.show` command.
- `src/tui/hooks/sidebar_live.ts` — unchanged refresh machinery; the snapshot's consumer moves.
- Depends functionally (not structurally) on harness `seed-pending-step-rows` for honest step totals; degrades to today's partial step lists against an unseeded ledger.
