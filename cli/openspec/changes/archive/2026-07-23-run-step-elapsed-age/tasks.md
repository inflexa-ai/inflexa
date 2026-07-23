# Tasks: run-step-elapsed-age

## 1. Carry the start time

- [x] 1.1 Add `startedAt?: string | null` to `RunStepView` (`src/tui/components/run_block.tsx`) with JSDoc stating it is meaningful for running rows and feeds the elapsed-age render
- [x] 1.2 Populate it from `r.startedAt` at both mapping sites: the sidebar-live refresh (`src/tui/hooks/sidebar_live.ts` step mapping) and the run-detail dialog's `loadedViews` (`src/tui/components/dialog/run_detail_dialog.tsx`)

## 2. Render the age

- [x] 2.1 In `RunBlock`'s step row, render `Date.relativeAge(Date.parse(startedAt))` in `<Fg role="fgMuted">` after the label, gated on `state === "running" && startedAt` parseable — a comment states why the gate lives in the render (mapping stays a dumb projection) and why the tone is the muted information tier, not `fgSubtle`
- [x] 2.2 Update the design-gallery run-block exhibit / run mock so a running row carries a start time and the new state is showcased

## 3. Tests and close-out

- [x] 3.1 Render tests: a running row with a start time shows the age with a resolved muted `fg` (span-color assertion, light theme included); done/failed/queued rows and a running row without a start time show none; rail-width frame stays within budget with the age present
- [x] 3.2 `bun run typecheck`, `bun test`, `bun run format:file` on touched `src/` files
- [x] 3.3 Sync/archive the delta specs when done
