# tui-sidebar-live — Design

## Context

Change 2 of doc 14. Change 1 landed the runtime-in-TUI: `bootState()`/`harnessRuntime()`
(`tui/hooks/boot.ts`) expose the pool once ready, the chat auto-triggers the profile, and runs
launch from conversation. The sidebar (`tui/layout/sidebar.tsx`) renders SESSION/ANALYSIS live but
CONTEXT/RUNS from `mock_fixtures`. Verified read surface (all barrel-exported, no harness work):
`loadDataProfileStatus → DataProfileStatus | null` (status pending/running/completed/failed, error,
timestamps, `result {summary, files[{path,description}], inputFileIds, profiledAt}`,
`seedInputFileIds`), `queryRunsByAnalysis → CortexRunRow[]` (newest-first, status/started/completed/
error/planId/threadId/attempts), `queryStepsByRun → StepExecutionRow[]` (status, duration_ms,
attempts, error, finish_reason). Reuse targets: `ResultsDialog` (title+lines scroll view),
`RunBlock` (`RunStepView` done/running/queued), the `inputsVersion` bus-tick pattern already in the
sidebar, `leaderSeq` (free keys include `d`, `r`), `onMouseUp` click pattern.

## Goals / Non-Goals

**Goals:** truthful sidebar (profile section + real runs), openable details views, graceful
pre-ready/pre-profile states, bounded live refresh.

**Non-Goals:** live run-event streaming (the DBOS run stream's read side is #33 M4 terrain — this
change POLLS ledger rows); a CONTEXT/token-cost section (no real accounting exists; deleted, not
faked); run cancellation/retry actions from the sidebar; proxy-chat retirement (change 3).

## Decisions

**D1 — Sections: SESSION, DATA PROFILE, ANALYSIS, RUNS.** CONTEXT is deleted — token/cost
accounting has no real source; per the no-fake-data rule it cannot stay. A live context section
returns when accounting exists (future change, out of scope).

**D2 — One sidebar data store (`tui/hooks/sidebar_live.ts`), status/boot precedent.** Module
singleton holding two snapshots (`profile: DataProfileStatus | null | "unavailable"`,
`runs: CortexRunRow[] | "unavailable"`) + a `refresh()` that no-ops until `harnessRuntime()` is
non-null, `.match`ing each read into the signals (a `DbError` → `"unavailable"`, never a crash).
Triggers: an effect on `[bootState().phase, workspace.analysis?.id]` (ready/swap → refresh), a
refresh when `chatStatus()` returns to idle (turns launch runs/profiles), and a **bounded poll**
(interval ~5s) armed ONLY while the last snapshot shows active work (profile pending/running, or
any run in a non-terminal status) — an idle sidebar costs zero queries. The store exposes a version
the Sidebar reads reactively; all snapshot writes are fresh objects.

**D3 — DATA PROFILE section rendering.** Pre-ready → dim "runtime not ready"; null row → dim "not
profiled"; pending/running → warn glyph + "profiling…"; completed → success glyph + file count +
relative `completedAt`; failed → error glyph + one-line error. One glyph + ≤2 muted lines — section
stays rail-width; the dialog carries the depth.

**D4 — RUNS section rendering.** Newest ≤4 rows: status glyph (running=warn, completed=success,
failed/canceled=error, else muted) + a short name (workflow name or plan id tail) + relative
`startedAt`. Empty → dim "no runs".

**D5 — Details views reuse existing dialog machinery.** Profile details = `ResultsDialog`
verbatim (composed lines: status, timestamps, error, summary paragraphs, per-file `path —
description`, seed-input count). Runs details = a thin new content dialog (dialog-system compliant:
cancel wiring, host esc, showcase-inert) listing recent runs and rendering the selected/latest
run's steps through `RunBlock` — whose `RunStepView` gains a `failed` state (glyph `✗`, error role;
design-system extension, gallery updated). Steps are fetched on dialog open (`queryStepsByRun`),
not in the sidebar poll.

**D6 — Open affordances.** `leaderSeq("d")` → profile details, `leaderSeq("r")` → runs details
(desc/group feed which-key; both base-mode, suspended under modals like every app key). Click: the
sidebar `Section` gains an optional activate callback wired to `onMouseUp` (primitive prop, layout
kit rule) on the DATA PROFILE and RUNS sections.

**D7 — Mock trim.** `sidebar.tsx` loses its `mock_fixtures` import. `mockRuns`/`mockContext` are
deleted unless the design gallery still consumes them (whatever the gallery showcases stays, as
gallery-only sample data; orphans die). The tui-mock-data spec keeps mock kinds for gallery
exhibits only.

**D8 — Polling is the deliberate v1 transport.** The run-event stream's read side does not exist
OSS-side (11 §5c); ledger polling (bounded, active-work-gated) is honest and cheap. When #33 M4
lands the read helper, the store's `refresh` seam is the single swap point.

## Risks / Trade-offs

- [Sidebar renders before boot → null pool] → D2's no-op guard + D3 pre-ready state; zero reads
  until ready.
- [Poll leaks when work never terminates] → interval armed from snapshot state only; a wedged
  `running` profile row is healed by the parity trigger's reconcile (change 1) on next open; runs
  stuck non-terminal keep a 5s poll alive — acceptable, bounded, and visible.
- [Query cost on big analyses] → `queryRunsByAnalysis` LIMIT (≤ 10) + steps fetched only on dialog
  open.
- [RunBlock prop change ripples] → only the gallery + new dialog consume it; `failed` is additive.
- [Click targets on a non-resizable rail] → whole-section activation (not per-row), matching the
  section-level affordance doc 14 asks for.
