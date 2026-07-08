# tui-sidebar-live — Tasks

## 1. Sidebar data store

- [x] 1.1 `tui/hooks/sidebar_live.ts` (status/boot store precedent): profile + runs snapshots,
      `refresh()` no-op until `harnessRuntime()` is non-null, `.match` every read (`DbError` →
      unavailable state, never a throw), fresh-object snapshot writes; JSDoc on exports (D2).
- [x] 1.2 Refresh triggers: effect on `[bootState().phase, workspace.analysis?.id]`, refresh when
      `chatStatus()` returns to idle, bounded ~5s poll armed ONLY while the snapshot shows active
      work (pending/running profile or non-terminal run) — idle arms nothing (D2). Unit-test the
      trigger/arming logic with seams (no Postgres).

## 2. Sections

- [x] 2.1 Sidebar sections become SESSION, DATA PROFILE, ANALYSIS, RUNS: CONTEXT removed, DATA
      PROFILE renders the D3 state ladder (pre-ready / not profiled / profiling / completed /
      failed), RUNS renders the D4 rows (newest ≤4, status glyph + name + relative time, "no
      runs" empty state); `mock_fixtures` import gone from the sidebar (D1/D7).
- [x] 2.2 Mock trim: delete `mockContext` (and `mockRuns` if the gallery no longer consumes it);
      whatever the gallery still showcases stays gallery-only (D7).

## 3. Details views

- [x] 3.1 Profile details via `ResultsDialog` reuse: lines composed from `DataProfileStatus`
      (status, timestamps, error, summary, per-file `path — description`, seed-input count);
      pre-ready/absent states render the muted fallback (D5).
- [x] 3.2 Runs details dialog (dialog-system compliant): recent runs list; selected/latest run's
      steps fetched on open via `queryStepsByRun` and rendered through `RunBlock`; `RunStepView`
      gains a `failed` state (additive; gallery exhibit updated) (D5).
- [x] 3.3 Gallery: showcase both dialogs via `DialogShowcase` and the new sidebar section states.

## 4. Affordances

- [x] 4.1 `leaderSeq("d")` → profile details, `leaderSeq("r")` → runs details (desc/group for
      which-key); `Section` gains an optional activate callback wired to `onMouseUp` on the two
      live sections (primitive prop) (D6).

## 5. Verification

- [x] 5.1 `bun run typecheck` + `bun run lint` clean; scoped `bun test` green; `format:file` on
      touched files.
- [x] 5.2 Cheap live check (no model turns): open the E2E analysis in the TUI; assert the sidebar
      renders the real profile state and at least one real run id from the ledger; record in
      findings.md.

## 6. Docs

- [x] 6.1 `00-progress.md` + doc 14 change-2 status updated.
