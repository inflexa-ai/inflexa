## Context

Run progress has three surfaces today: the sticky `RunProgressRow` (chat column, `app.tsx` mount, fed by `activeRunProgress` from `sidebar_live.ts`), the sidebar RUNS section (4 one-line rows, `sidebar.tsx`), and `RunsDialog` (recent-runs list + the latest run's steps only, opened by the RUNS title click and `ctrl+x r`). The store side (`sidebar_live.ts`) already publishes everything the new layout needs — refresh triggers, the bounded poll, and the active-run snapshot — so this change moves renderers, not data plumbing. The palette has an exact structural precedent for picker → detail: `plan.explore-steps` (`commands.tsx`), which opens a `SelectDialog` and then a detail dialog.

The harness change `seed-pending-step-rows` makes `queryStepsByRun` return the full DAG (pending rows seeded at run start). `stepStateOf` already maps `pending`/`skipped` → the `queued` view state, so the CLI needs no mapping work to show upcoming steps.

## Goals / Non-Goals

**Goals:**
- One home for live run progress: the sidebar RUNS section.
- Any run reachable for inspection in ≤2 interactions (palette/title → search → detail).
- A rail that scrolls instead of clipping when content outgrows short terminals.

**Non-Goals:**
- No run-event stream consumption; polling stays the transport.
- No pagination in the runs picker (the 100-row cap + fuzzy search is deliberate; no analysis is expected to approach it).
- No per-step drill-down dialog in the run detail (v1 is metadata + full step list; attempts/blocked-reason drill-down can layer on later).
- No change to the refresh/poll machinery in `sidebar_live.ts`.

## Decisions

**D1 — `RunBlock` gains `heading?: boolean` (default `true`), rather than extracting a bar+steps sub-component.** The sidebar embed sits directly under the run's own row (glyph + name + age), so repeating the RunBlock name/tag line would be noise. A prop keeps the meter scaling, frontier windowing, and step-mark logic in the one component all surfaces share; an extracted sub-component would be a single-real-caller split (the CLI forbids those) and RunBlock's own heading is one line. The dialog and gallery mounts keep the default.

**D2 — The sidebar embed reuses the windowed narrow mount (`maxSteps={6}`, same as the sticky row had).** The rail is `size.railWidth` (40) columns — the same width class the sticky row's `BAR_BUDGET`-scaled meter and 6-step frontier window were tuned for, so those values port unchanged. The embed renders only while `activeRunProgress()` is non-null, directly under the newest run row (the snapshot is always the newest run's — `refreshSidebarData` clears it when the newest run is terminal, so no run-row/progress mismatch is representable).

**D3 — The rail scrolls via `ScrollPane` wrapping the section stack, `focusOnMount={false}`.** The sections keep their natural heights; the pane absorbs overflow. The scrollbox-bleed rule (CLAUDE.md Layout) applies to fixed chrome *below* a `flexGrow` scrollbox — the rail's pane is the column's only flexible child with nothing below it, so no painted-footer recipe is needed; verify with the height-sweep harness anyway since these bugs are size-dependent. Mouse-wheel scrolling suffices; no scroll keybindings are added (the rail is not a focus target).

**D4 — Picker fetches fresh at open: `queryRunsByAnalysis(pool, analysisId, { limit: 100 })`, newest-first.** The live snapshot holds only `RUNS_LIMIT = 10` rows tuned for the rail; investigation needs history. Fetch-then-open matches the palette's analysis/session pickers. 100 is a deliberate cap, not pagination — fuzzy search narrows within it, and the picker row text (short name, id tail, status, absolute start time) gives search enough surface. Rows: title = `shortRunName` + id tail, description = status + `absTime(startedAt)`.

**D5 — Detail stacks on the picker (no close-then-open).** The dialog host keeps lower entries mounted-but-inert, so pushing the detail over the picker gives esc-pops-back-to-browsing for free — the right shape for "investigate runs" (inspect several in a row). This deliberately diverges from `plan.explore-steps`' close-then-open, which suits its one-shot lookup. Detail content: status glyph + status, absolute started/completed, duration via `Date.formatDuration` (elapsed age for a still-running run), the error when failed, then the full step list through `RunBlock` (no `maxSteps`, `hint={false}`, default heading — in the dialog the block IS the heading). Steps fetched once on open via the injected `loadSteps` seam (same shape RunsDialog used), keeping the dialog offline-testable and gallery-showcaseable.

**D6 — `RunsDialog` is replaced, not evolved.** The picker is a `SelectDialog` composition living in the command/run-open path; the new `run_detail_dialog.tsx` replaces `runs_dialog.tsx` (file + tests + gallery exhibit). `openRuns` in `app.tsx` becomes "fetch runs → push picker"; the RUNS title click and `ctrl+x r` keep their existing wiring through it, so discoverability (which-key, selection-drag guard) is untouched.

**D7 — Accepted: hidden sidebar means no live progress.** Explicit user decision. The run-started card in the stream still announces the launch; the sidebar is open by default; `ctrl+b` brings it back.

## Risks / Trade-offs

- [Rail sections lose "always visible at a glance" once the rail scrolls] → Sections above RUNS (SESSION/ANALYSIS/PROFILE) are short and RUNS is bounded (3 rows + ≤6-step window); overflow only bites on short terminals where clipping was strictly worse.
- [ScrollPane in the rail steals wheel events from the chat stream when the pointer is over the rail] → That is the expected hover-scroll semantic; the stream keeps its own pane.
- [Unseeded (pre-harness-change) runs show partial step lists in the detail dialog] → Same honesty as today; degrades, never crashes. No CLI-side plan join is added to compensate.
- [100-run cap silently hides older runs] → The picker's title/footer states the cap when exactly 100 rows return ("newest 100"), so truncation is visible rather than silent.

## Migration Plan

Pure TUI rework, no data migration. Land after or alongside the harness `seed-pending-step-rows` change for full effect; safe in either order (renders whatever the ledger returns). Rollback = revert.

## Open Questions

None — the exploration's open decisions were settled with the user (D1/D2 delegated, D7 accepted, cap-without-pagination chosen).
