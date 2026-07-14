## 1. Run block + sidebar embed

- [x] 1.1 Add the heading opt-out prop to `RunBlock` (`src/tui/components/run_block.tsx`), default unchanged; dialog/gallery mounts keep the heading
- [x] 1.2 Render the active-run progress embed in the sidebar RUNS section (`src/tui/layout/sidebar.tsx`): under the newest run row, `RunBlock` with heading suppressed, `maxSteps={6}`, `hint={false}`, shown iff `activeRunProgress()` is non-null
- [x] 1.3 Cap the RUNS list at 3 (`recentRuns` slice in `sidebar.tsx`)
- [x] 1.4 Wrap the rail's section stack in a vertical `ScrollPane` (`focusOnMount={false}`, no scroll keybindings); sweep a range of terminal heights with the `testRender` harness for clipping/bleed regressions
- [x] 1.5 Update `sidebar.render.test.tsx` for the embed, the 3-run cap, and the scrollable rail

## 2. Remove the sticky row

- [x] 2.1 Delete `src/tui/layout/run_progress_row.tsx` + `run_progress_row.render.test.tsx` and unmount it from `app.tsx`
- [x] 2.2 Remove its design-gallery exhibit; add/adjust a gallery exhibit for the sidebar RUNS section with the progress embed

## 3. Picker → detail flow

- [x] 3.1 Build the run-detail dialog (`src/tui/components/dialog/run_detail_dialog.tsx`): metadata block (status glyph+status, absolute started/completed, duration via `Date.formatDuration` or elapsed for a running run, error when failed) + full step list via `RunBlock` (no `maxSteps`, `hint={false}`); steps fetched once at open through an injected `loadSteps` seam; dialog-system compliant (host esc, `useDialogCancel`, initial focus, showcase-inert)
- [x] 3.2 Build the runs-picker open path: fetch `queryRunsByAnalysis(pool, analysisId, { limit: 100 })` newest-first, open a `SelectDialog` (rows: short name, id tail, status, absolute started time; state the cap when exactly 100 return); on select, push the run-detail dialog OVER the picker (no close-then-open); degrade pre-ready to the muted not-ready state without querying
- [x] 3.3 Delete `runs_dialog.tsx` (+ its tests and gallery exhibit); rewire `openRuns` in `app.tsx` to the picker path (RUNS title click via the selection-drag guard, `ctrl+x r` leader chord unchanged)
- [x] 3.4 Add the `runs.show` "Show runs" palette command in `src/tui/commands.tsx` (`enabled` gates on runtime ready), routing through the same open path
- [x] 3.5 Gallery-showcase the picker and the run-detail dialog; run-detail tests (pure `runDetailLines` states + rendered metadata/step-glyph/degrade frames). The picker composes the already-tested `SelectDialog` and its row mapping is exercised by the gallery exhibit; the cap notice and stacked esc-pops-to-picker live in the command layer (untested by that layer's convention) and fall to the 4.2 interactive drive

## 4. Verification

- [x] 4.1 `bun run typecheck`, `bun run lint`, `bun test`; `bun run format:file` on touched files
- [x] 4.2 Drive the real app (`/verify`-style): launch a multi-step run, confirm the sidebar embed shows queued steps (against a seeded ledger), open the picker from all three entry points, inspect a historical run — needs a booted harness (infra up + model connection); not runnable headlessly in the implementation session
