## Context

Eight UI polish items across the chat TUI, all grounded in the current code:

1. The data-profile details dialog renders `started 5m` / `completed 4m` via `relAge` → `Date.relativeAge` (`src/tui/hooks/sidebar_live.ts:88-90`, `src/extensions/date.ext.ts:14-22`). The "never a raw date" choice is documented at `sidebar_live.ts:56-59` for fixed-width surfaces — this change consciously reverses it for detail dialogs only. Both `data_profile_started_at` and `data_profile_completed_at` are ISO strings in the harness ledger; `completedAt` is stamped on failure paths too, so duration is derivable for completed *and* failed profiles.
2. The runs dialog's progress bar is already the reusable `RunBlock` (`src/tui/components/run_block.tsx`, primitive props). Run rows arrive by the sidebar refresh loop (lifecycle edges + bounded 5s poll while work is active); steps are fetched exactly once at dialog open (`runs_dialog.tsx:104-116`). The chat's `run-card` part deliberately carries no live status.
3. `ToolBlock` stacks name and status as two sibling `<text>` rows in a column box (`tool_block.tsx:45-74`); an optional bordered result panel renders between them (fixture/gallery-only for live events).
4. The path under the sidebar's ANALYSIS name is the anchor's `cachedPath` (the cwd where the analysis was created, self-healing on move) with a ✓/⚠ `markerWritten` badge. The canonical working dir is `ws.workingDir` on the workspace store (`src/tui/contexts/workspace.ts`, from `add-workspace-context`).
5. Text selection is an opentui renderer feature the app already drives (`renderer.getSelection()?.getSelectedText()` / `renderer.clearSelection()` — copy-on-select at `app.tsx:264-270`). ESC does nothing to selection natively. The keymap engine (`add-keymap-engine`, implemented) provides mode-less layers, `priority`, and per-keystroke `enabled` thunks.
6. User and assistant turns differ only by header marker/color (`message_block.tsx:44-53`); bodies render identically.
7. All list cursor logic lives in `ListCore` (`list_core.tsx:171-179`); `up`/`down`/`moveBy` clamp. `FixedList` and `DynamicList` are its only callers. The config screen's section nav duplicates the clamp pattern (`app_config.tsx:279-280`).
8. Sidebar sections stack `LABEL` above content (`sidebar.tsx:135-146`); the rail is a fixed `size.railWidth` = 40 columns. opentui 0.4.2 supports `justifyContent: "space-between"`, `gap`, and word-wrap (`wrapMode` defaults to `"word"` once a box has resolved width); the `<box flexGrow={1}/>` spacer idiom is used in StatusBar and ChatBar.

Prerequisites `add-keymap-engine` and `add-workspace-context` are implemented but unarchived; this change builds on them and does not modify them.

## Goals / Non-Goals

**Goals:**

- Absolute local timestamps + duration on durable-record surfaces (profile details, runs details), with the rule codified in `cli/CLAUDE.md`.
- A sticky run-progress row in the chat column while a run is active, fed by the existing refresh loop.
- Inline tool status, prop-controlled; user-turn left rule; ESC-clears-selection; FixedList wrap-around; responsive path placement; responsive sidebar label rows.
- One shared duration formatter replacing the three inline ones.

**Non-Goals:**

- No live run-event stream transport — polling stays the v1 transport; the sticky row rides the existing loop.
- No user-config time-format key — `toLocaleString()` (system locale) *is* the user's preferred format; a config key was rejected as scope creep.
- No per-tool-name rendering switches — placement is a `ToolBlock` prop, not a tool registry.
- No `DynamicList` wrap, no page-movement wrap, no radio-stepping wrap.
- No sidebar width responsiveness (rail stays fixed 40) and no mouse resize.
- The empty-chat Welcome block's anchor-path line is unchanged.

## Decisions

### D1 — Absolute time = `toLocaleString()`; duration via one shared formatter

Durable, referenced records get `new Date(iso).toLocaleString()` — the established absolute-time precedent (session-switch dialog, whoami, `analysis ls`). Rejected: a new `config.json` time-format key (nothing else in the app has one; the OS locale already encodes the preference).

Site-by-site (the piece-by-piece enumeration the rule demands):

| Site | Today | After |
|---|---|---|
| Profile details dialog `started`/`completed` lines (`profileDetailLines`) | `relAge` | absolute + a `duration` line (`completedAt − startedAt`; running shows live elapsed from `startedAt`) |
| Runs details view `RECENT RUNS` rows | `relAge(startedAt)` | absolute started time |
| Sidebar rail (session age, profile age, run age) | `relAge`/`relativeAge` | unchanged (live fixed-width surface) |
| Boot/thinking elapsed indicators | `relativeAge` | unchanged (live elapsed) |
| `commands.tsx` / text commands | `toLocaleString()` | unchanged (already absolute) |

Duration formatter: `Date.formatDuration(ms)` beside `Date.relativeAge` in `src/extensions/date.ext.ts` (the established home for cross-cutting date helpers; 4+ callers justify it). Format: `<1s → NNNms`, `<60s → N.Ns` (the dominant existing `tool_block` style), `≥60s → NmSSs` — profile runs can take minutes and `312.5s` is unreadable. `tool_block`, `thinking_block`, `message_block`, and the new profile duration line all adopt it; `thinking`/`message` blocks change from whole seconds to this format (accepted — one vocabulary beats three).

### D2 — Sticky run progress: data from the refresh loop, layout from the BootIndicator recipe

**Data.** `refreshSidebarData` additionally fetches `queryStepsByRun` for the newest **non-terminal** run and exposes an `activeRunProgress` snapshot (name, tag, done, total, step views) beside the existing signals. Cost: one extra bounded query per refresh, only while work is active — an idle sidebar still issues zero queries. `stepStateOf` (status → done/running/failed/queued) lifts from `runs_dialog.tsx` into `sidebar_live.ts` next to `runMark`/`shortRunName`; the dialog imports it from there. Rejected: a separate poller (duplicates the generation-token/skip machinery) and bus events (the bus carries only prov events by design).

**Layout.** A new shell part `src/tui/layout/run_progress_row.tsx` composes `RunBlock`, mounted in `app.tsx` between `<Chat>` and the boot-indicator slot. It MUST follow the documented scrollbox-bleed recipe (`app.tsx:410-415`): full-width, painted with the app background, `flexShrink={0}` — the chat stream (flexGrow + minHeight 0) yields the squeeze. Visible iff `activeRunProgress` is non-null (newest run non-terminal); it auto-hides on terminal status. No dismiss key in v1.

**Density.** `RunBlock` gains an optional `maxSteps?: number` prop: when `steps.length > maxSteps`, render a window of `maxSteps` steps centered on the first non-done step (the bar and `done/total` always show the full run). The sticky row passes a small cap (6); the dialog passes nothing (full list). This keeps the chat usable for long runs without a second progress widget. New gallery exhibit for the sticky row state.

### D3 — Tool status placement is a `ToolBlock` prop

`ToolBlock` gains `inlineStatus?: boolean`, defaulting to `props.result === undefined`: live harness events (which never carry `result`) render `▸ name target  ✓ ok · 14ms` on one line with a `space.md` gap; a block with a result panel keeps the completion line below the panel (the spec'd "completion line" survives for that case, and the gallery pins both states via the explicit prop). Rejected: right-aligning the status via a row + `flexGrow` spacer — a wrapped right-aligned segment lands at column 0 and breaks the fixed 2-cell gutter; a plain gap soft-wraps more gracefully. Verified with `testRender`/`captureCharFrame` sweeps including width 40 (sidebar-open chat column).

### D4 — Responsive path placement via a breakpoint token

New token `size.breakpointWide` (columns; calibration value **120**, tunable) in `design_system.ts`. `app.tsx` reads `useTerminalDimensions()` and:

- **width ≥ breakpoint**: `StatusBar` renders the workspace path as a new segment immediately after the state segment (` | ~/repos/…`), sourced from `ws.workingDir`, home-contracted to `~`. It is NOT part of the right-aligned hints region.
- **width < breakpoint**: the path renders where it does today — the sidebar ANALYSIS section line with the ✓/⚠ badge.

The ✓/⚠ `markerWritten` badge never moves to the header (it is anchor-marker health, not cwd identity): when the path line is header-borne, the badge joins the ANALYSIS meta line (`✓ 2 inputs · proj: x`). Note the two values can diverge in the unresolved-anchor edge (`workingDir` falls back to `process.cwd()`; `cachedPath` keeps the stale hint) — the header shows `workingDir` because it is what the chat actually roots at.

### D5 — ESC clears selection as a mode-less, high-priority layer

In `app.tsx`: `useBindings(() => ({ priority: 50, enabled: () => !!renderer.getSelection()?.getSelectedText(), bindings: [{ chord: KEYS.escape, run: () => renderer.clearSelection(), … }] }))`. Mode-less so it works under dialogs; priority above the dialog host's default-0 layer, below the abort layer (100). The `getSelectedText()` predicate (not bare `hasSelection`) is the app's established "real selection" idiom — a plain click on selectable text creates an empty Selection. Clear only, no copy (copy-on-select already covers copying). Accepted interaction: the engine's pending-leader-chord abort runs before all layers, so ESC mid-chord aborts the chord and leaves the selection; the next ESC clears it.

### D6 — User-turn left rule, gutter alignment preserved

The user turn's parts container gets `border={["left"]} borderColor={theme().user}` — the established quoted-content idiom (thinking/plan/run blocks). Alignment invariant: the border glyph consumes one cell, so the user body's `paddingLeft` drops from `space.md` (2) to `space.sm` (1), keeping body text at the same column as assistant turns (border 1 + padding 1 = gutter 2). The header line (marker `>` at column 0) stays outside the bordered box so the gutter marker column is untouched. Pinned by a frame assertion; gallery's "plain chat turn" exhibit updated. Rejected: full background fill (`bgRaised`) — heavier, interacts with border-on-background painting and the theme-contrast tests.

### D7 — Wrap-around is a `ListCore` option that only `FixedList` enables

`ListCore` gains `wrapNavigation?: boolean` (default false). When true, single-step moves wrap modularly (`(i+1) % n`, `(i−1+n) % n`) — covering ↑/↓, ctrl+p/ctrl+n, j/k. `FixedList` passes `wrapNavigation` on; `DynamicList` does not (user decision: wrap only the fixed list — a filtering/refreshing dynamic source makes a surprise jump to the far end more disorienting). `moveBy(±10)` (page keys) keeps clamping everywhere; `gg`/`G` and the filter-shrink clamp are untouched. The config screen's section nav (`app_config.tsx`) adopts the same modular wrap in its own handlers (it does not use ListCore); its radio stepping stays clamped. Test fallout is known and owned: `list_primitives.render.test.tsx:148-151` (ctrl+p-clamps-at-0 assertion flips to wrap) and `dialog_host.render.test.tsx:424-465` (config "down past the end clamps" becomes exact-count navigation); new cases pin wrap at both ends and the single-row no-op.

### D8 — Sidebar label rows: measured merge with stacked fallback

The `Section` wrapper gains an optional `value?: string` prop. When provided and `label.length + gap + value.length` fits the usable rail width (railWidth − horizontal padding − border = 37 cells; 1 char = 1 cell in the terminal), the section header renders as one row — `LABEL <flexGrow spacer> value` (the StatusBar/ChatBar spacer idiom). When it does not fit, the section renders exactly today's stacked layout (value on its own full-width line, free to word-wrap). Adopters: SESSION (short id), ANALYSIS (name), DATA PROFILE (status word). RUNS and MODELS keep stacked layouts — their content is a row list, not a single value. Rejected: unconditional row + intra-cell word-wrap — a name wrapping *inside* the right cell (`SESSION  drug-repurposing-` / 9 spaces + `screen-v2`) reads worse than the stacked fallback the user sketched. Every relayout is verified with `testRender`/`captureCharFrame` sweeps across widths/heights per the CLAUDE.md layout rule (measure, don't reason by CSS analogy).

## Risks / Trade-offs

- [Scrollbox bleed corrupts the sticky row] → follow the documented recipe exactly (full-width painted `flexShrink={0}` box); frame-assert at several heights, as the bugs are size-dependent.
- [Sticky row + boot indicator + error banner stack up and squeeze short terminals] → the chat stream is the designated squeeze absorber (flexGrow + minHeight 0); sweep heights in tests; the step window (`maxSteps`) bounds the row's height.
- [Merged tool line soft-wraps on narrow terminals, wrapped status lands at column 0] → accepted for v1 (wrap beats clip for information); the gap layout degrades more gracefully than right-alignment; pinned in a width-40 frame test.
- [StatusBar has no truncation; a long path + long analysis name can collide with the hints] → home-contraction plus the breakpoint gate make it rare; accepted residual risk, consistent with the bar's existing no-truncation behavior. If it bites, middle-truncate the path segment in a follow-up.
- [`toLocaleString()` output length varies by locale] → detail dialogs are `md`-preset panels (64 cols) with scrolling; not a fixed-width rail. The rail keeps relative ages precisely to avoid this.
- [Wrap-around surprises muscle memory in pickers] → single-step only; page keys and `gg`/`G` still hard-stop, so "slam to the end" gestures keep working.
- [Poll-fed sticky progress lags up to one poll interval] → inherent to the v1 transport; the refresh-on-turn-completion edge covers the common "agent launched a run" case. The documented swap point (`refreshSidebarData`) is unchanged for the future stream transport.
- [`add-keymap-engine` also carries an unsynced `key-bindings` delta] → this change only ADDS a requirement to that capability; the deltas are disjoint and archive in either order.

## Migration Plan

UI-only; no data, schema, or config migration. Single branch, lands as one change. Rollback = revert.

## Open Questions

None — all decision points were resolved with the user (format source, step fetching, prop-based tool placement, breakpoint-gated path placement, wrap scope limited to FixedList + config sections).
