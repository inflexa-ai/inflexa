## 1. Shared foundations

- [x] 1.1 Add `Date.formatDuration(ms)` to `src/extensions/date.ext.ts` beside `relativeAge` (`<1s → NNNms`, `<60s → N.Ns`, `≥60s → NmSSs` per design D1), with unit tests covering all three ranges and the boundaries
- [x] 1.2 Add `size.breakpointWide: 120` to `size` in `src/lib/design_system.ts` (with a calibration-value doc comment)
- [x] 1.3 Replace the three inline duration formatters (`tool_block.tsx`, `thinking_block.tsx`, `message_block.tsx`) with `Date.formatDuration`; update any render assertions that pinned the old whole-second strings
- [x] 1.4 Add the time-rendering rule to `cli/CLAUDE.md`: durable referenced records get absolute local timestamps (`toLocaleString()`); live/ephemeral fixed-width readouts keep compact relative ages

## 2. Absolute time + duration on detail views

- [x] 2.1 `profileDetailLines` (`src/tui/hooks/sidebar_live.ts`): `started`/`completed` lines become absolute (`toLocaleString()`); add a `duration` line via `Date.formatDuration` for completed AND failed profiles; a running profile shows live elapsed since `startedAt` instead; update `sidebar_live.test.ts` line assertions
- [x] 2.2 Runs dialog RECENT RUNS rows (`runs_dialog.tsx`): replace `relAge(run.startedAt)` with the absolute started time; update `runs_dialog` render tests
- [x] 2.3 Verify the sidebar rail still renders relative ages everywhere (session age, profile age, run age) — pin with the existing `sidebar.render.test.tsx` assertions

## 3. FixedList wrap-around navigation

- [x] 3.1 Add `wrapNavigation?: boolean` (default false) to `ListCore` (`list_core.tsx`): `up`/`down` wrap modularly when enabled; `moveBy`, `gg`/`G`, and the filter-shrink clamp unchanged; `FixedList` passes it on, `DynamicList` does not
- [x] 3.2 Wrap the config screen's section navigation (`app_config.tsx` up/down handlers) with the same modular arithmetic; radio left/right stepping stays clamped
- [x] 3.3 Update tests: flip the ctrl+p-clamps assertion in `list_primitives.render.test.tsx:128-155` to expect wrap; add wrap-at-bottom, wrap-at-top, and single-row no-op cases; rewrite the exact-count config navigation in `dialog_host.render.test.tsx:424-465`; add a DynamicList still-clamps case in `file_picker` or list-primitives tests

## 4. ESC clears the active text selection

- [x] 4.1 Register the mode-less layer in `app.tsx`: `enabled: () => !!renderer.getSelection()?.getSelectedText()`, priority above the dialog host's esc and below the abort layer, `run: () => renderer.clearSelection()` (clear only, no copy)
- [x] 4.2 Add render tests: esc with a selection clears it and leaves an open dialog open; esc with a selection keeps textarea focus (no INSERT→NORMAL flip); esc without a selection behaves exactly as before

## 5. Inline tool status

- [x] 5.1 Add `inlineStatus?: boolean` to `ToolBlock` (default `props.result === undefined`): inline form renders name + target + `space.md` gap + status on one line; result form keeps the completion line under the `<code>` panel
- [x] 5.2 Update the design gallery tool exhibits to pin both forms via explicit `inlineStatus` values
- [x] 5.3 Add frame-assertion tests for both placements, including a 40-column width sweep for the inline form's soft-wrap behavior

## 6. User-turn left rule

- [x] 6.1 In `MessageBlock`, wrap the user turn's parts container in `border={["left"]} borderColor={theme().user}` with left padding reduced by one cell so body text stays column-aligned with assistant bodies; the header line (gutter `>` marker) stays outside the bordered box
- [x] 6.2 Add a frame test pinning the alignment invariant (user and assistant body text in the same column); update the gallery's plain-chat-turn exhibit; run the `theme_contrast` render tests across themes

## 7. Sticky run progress in the chat

- [x] 7.1 Lift `stepStateOf` from `runs_dialog.tsx` into `sidebar_live.ts` beside `runMark`/`shortRunName`; update the dialog's import
- [x] 7.2 Extend `refreshSidebarData` to fetch `queryStepsByRun` for the newest non-terminal run (inside the generation-token guard) and publish an `activeRunProgress` snapshot signal (name, tag, done/total, step views), null when no run is active; test: idle refresh issues zero step queries, active run publishes, terminal run clears
- [x] 7.3 Add `maxSteps?: number` to `RunBlock`: when steps exceed it, render a window centered on the first non-done step (bar and done/total always reflect the full run); gallery-pin the windowed state
- [x] 7.4 Create `src/tui/layout/run_progress_row.tsx` composing `RunBlock` (small `maxSteps`, `hint={false}`) from `activeRunProgress`; mount it in `app.tsx` between `<Chat>` and the boot-indicator slot following the scrollbox-bleed recipe (full-width, app-background-painted, `flexShrink={0}`)
- [x] 7.5 Frame tests: row appears iff the snapshot is non-null, disappears on terminal status, and survives short-terminal squeezes without bleed (sweep several heights)

## 8. Responsive workspace path

- [x] 8.1 Add the optional path-segment prop to `StatusBar` (`status_bar.tsx`), rendered muted immediately after the state segment, before the right-aligned hints
- [x] 8.2 In `app.tsx`, gate the prop on `useTerminalDimensions().width >= size.breakpointWide`, sourcing `ws.workingDir` with the home directory contracted to `~`
- [x] 8.3 In `sidebar.tsx`, render the ANALYSIS path line (badge + path) only below the breakpoint; at/above it, move the ✓/⚠ badge onto the ANALYSIS meta line (inputs · project)
- [x] 8.4 Render tests at widths straddling the breakpoint: exactly one surface carries the path at any width, and the badge is always visible somewhere in ANALYSIS

## 9. Sidebar responsive label rows

- [x] 9.1 Add an optional `value?: string` to the sidebar `Section` wrapper: when `label + gap + value` fits the usable rail width (railWidth − padding − border, measured in cells), render one row with a `flexGrow` spacer; otherwise render today's stacked layout; adopt for SESSION (short id) and ANALYSIS (name); DATA PROFILE stays stacked (its first line is a glyph-bearing composite, not a single value — delta spec amended to match); RUNS keeps stacked
- [x] 9.2 `testRender`/`captureCharFrame` sweeps: short values merge onto the label row, a long analysis name falls back to stacked (never wrapped inside a right-hand cell); update `sidebar.render.test.tsx`

## 10.5 Smoke-pass feedback fixes

- [x] 10.5.1 Sidebar DATA PROFILE completed line shows the absolute completed time (`absTime`, like the details dialog) instead of `relAge`; RUNS rows and SESSION age stay relative (absolute start times would overflow the 37-cell rail); flip the rail-pinning assertion in `sidebar.render.test.tsx`; adjust the CLAUDE.md time-rendering example so the rail-profile line reads as a durable-record readout
- [x] 10.5.2 SelectDialog breathing room: a small gap between the filter input and the list, padding above the cursor-row description INSIDE its painted full-width box (a transparent gap would expose the scrollbox bleed), and top/bottom panel padding for the picker content; verify with frame sweeps that no bleed appears through the new spacing; update any pinned render tests
- [x] 10.5.3 `Date.relativeAge` renders two units when the age is a minute or more (`31s`, `5m31s`, `8h54m`, `2d04h` — largest unit + the next one down, seconds-only below a minute); update its unit tests and every render assertion pinning single-unit ages

## 10. Verification

- [x] 10.1 `cd cli && bun run typecheck && bun run lint && bun test` all green
- [x] 10.2 `bun run format:file` on every touched file under `src/`
- [x] 10.3 Manual `bun run dev` smoke pass over all eight behaviors (profile dialog times, sticky progress during a run, inline tool status, header/sidebar path at two terminal widths, esc-deselect, user-turn rule, picker wrap-around, sidebar label rows) — performed by the user; the resulting feedback fixes are group 10.5
