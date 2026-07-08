# tui-sidebar-live — Proposal

## Why

The sidebar still lies: CONTEXT and RUNS render mock fixtures (`tui/layout/sidebar.tsx:110-144`)
while the ledger now holds real data the TUI can read — the data profile the chat auto-triggers and
the runs it launches (change 1, `tui-harness-chat`). Change 2 of the binding direction
(`docs/harness_integration_followup/14-tui-chat-direction.md`): the sidebar tells the truth — a
data-profile section the user can open for details, real runs, no fake data anywhere.

## What Changes

- **New DATA PROFILE sidebar section** replacing CONTEXT: live status from `loadDataProfileStatus`
  (not profiled / pending / running / completed / failed, with a one-line summary), degrading
  gracefully before the runtime is ready. Clickable and keybound to a **details view** (dialog):
  status, timestamps, error, the profile summary, and per-file descriptions from the ledger result.
- **RUNS section goes live**: newest runs from `queryRunsByAnalysis` (status glyph, name, relative
  time) replacing `mockRuns`; clickable and keybound to a **runs details view** with per-run steps
  from `queryStepsByRun` rendered through the existing `RunBlock` (which gains a failed-step state).
- **Live refresh**: one sidebar data store re-reads on boot-ready, analysis swap, and turn
  completion, plus a bounded poll only while work is active (profile running or a run non-terminal).
- **No fake data remains in the product UI**: the sidebar's mock imports go; mock fixtures survive
  only where the design gallery still showcases them (orphaned fixtures are deleted).
- No harness changes: every read and type is already barrel-exported (`loadDataProfileStatus` +
  `DataProfileStatus`, `queryRunsByAnalysis`/`queryStepsByRun` + `CortexRunRow`/`StepExecutionRow`/
  `RunStatus` — `harness/src/index.ts:203-204, 259-262`).

## Capabilities

### New Capabilities
- `sidebar-live`: the sidebar's live-data contract — sources, refresh triggers, pre-ready
  degradation, and the profile/runs details views (click + leader keybinds, dialog subsystem).

### Modified Capabilities
- `tui-layout`: the "Toggleable four-section sidebar" requirement — sections become SESSION, DATA
  PROFILE, ANALYSIS, RUNS; the CONTEXT/RUNS mock-data mandate is inverted to live ledger data.
- `tui-mock-data`: the sidebar is no longer a mock consumer; mock fixtures remain gallery-only
  (the token-cost model is deleted if it loses its last consumer).

## Impact

- `cli/src/tui/layout/sidebar.tsx` (sections + click), `cli/src/tui/hooks/` (new sidebar data
  store), two new content dialogs under `cli/src/tui/components/dialog/` (profile details; runs
  with steps), `cli/src/tui/components/run_block.tsx` (failed-step state), `cli/src/tui/app.tsx`
  (two leader bindings), `cli/src/tui/layout/design_gallery.tsx` (new exhibits),
  `cli/src/lib/mock_fixtures.ts` (consumer trim). No harness changes, no new dependencies. Live
  verification is nearly free: opening the E2E analysis renders the real profile + runs already in
  the ledger (no model tokens beyond the boot probe).
