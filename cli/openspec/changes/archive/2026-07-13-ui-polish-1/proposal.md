## Why

Eight small UX papercuts accumulated across the chat TUI: times render as bare relative ages where the user actually needs a readable date, run progress is locked inside a dialog, tool blocks waste horizontal space, the sidebar's anchor path is unexplained and its label rows waste vertical space, ESC ignores an active text selection, user turns are visually indistinguishable from assistant turns beyond the gutter marker, and fixed lists dead-stop at their ends. Each is small; together they define one polish pass with a shared theme — make the shell read better and navigate tighter without new subsystems.

## What Changes

- **Absolute time for durable records.** The data-profile details dialog shows absolute local timestamps (`toLocaleString()`) plus the profile duration; the runs details view shows absolute started times. Live fixed-width surfaces (sidebar rail, elapsed indicators) keep compact relative ages. The rule of thumb is codified in `cli/CLAUDE.md`: **durable, referenced records get absolute local timestamps; live/ephemeral readouts keep relative ages.** A shared duration formatter replaces the three near-identical inline formatters.
- **Sticky run progress in the chat.** While a run is non-terminal, the chat column shows a sticky progress row (the `RunBlock` progress vocabulary: segmented bar, done/total, steps) pinned above the input, fed by the sidebar refresh loop — which now also fetches the newest active run's steps.
- **Inline tool status.** `ToolBlock` gains a prop controlling status placement; live tool events (no result panel) render name and status on one line with a gap; a block with a result panel keeps the completion line below the panel.
- **Workspace path, responsively placed.** A terminal-width breakpoint token enters the design system. At or above it, the StatusBar shows the workspace path immediately after the status segment; below it, the path stays in the sidebar ANALYSIS section (with its anchor-health badge, which never leaves the sidebar).
- **ESC clears the active text selection** before any other esc behavior, via a mode-less high-priority keymap layer; with no selection, esc falls through unchanged.
- **User turns get a left border rule** in the user theme color (the established quoted-content idiom), keeping gutter alignment intact.
- **Fixed lists wrap around**: single-step cursor navigation (↑/↓, ctrl+p/n, j/k) wraps 0 ↔ N−1 in `FixedList`; `DynamicList` keeps clamping; page movement and gg/G are unchanged. The config screen's section navigation wraps the same way.
- **Sidebar label rows go horizontal**: each section renders `LABEL <flex gap> value` on one row when the pair fits the rail width, falling back to today's stacked layout when it does not.

## Capabilities

### New Capabilities

None — every item lands in an existing capability.

### Modified Capabilities

- `sidebar-live`: the profile details dialog renders absolute timestamps + duration (was: relative ages); the runs details view renders absolute started times; the refresh loop additionally fetches the newest active run's steps (was: steps fetched only at dialog open) to feed the chat's sticky progress row.
- `tui-layout`: StatusBar gains the responsive workspace-path segment; the sidebar's ANALYSIS path becomes narrow-terminal-only; sidebar sections adopt the responsive label-row layout; `MessageBlock` differentiates user turns with a left rule; the chat-shell composition gains the sticky run-progress row between stream and input.
- `tui-stream-blocks`: the tool block's completion line becomes placement-controlled (inline beside the name for live events; below the result panel when one renders).
- `list-primitives`: cursor navigation end behavior splits by component — `FixedList` wraps on single-step movement, `DynamicList` clamps; paging and gg/G clamp everywhere.
- `key-bindings`: new requirement — esc clears the renderer's active text selection before any other esc behavior.
- `tui-design-tokens`: new terminal-width breakpoint token for the responsive path placement.

## Impact

- `src/tui/hooks/sidebar_live.ts` — absolute time lines, duration, step fetching in the refresh loop, step-view mapping lifted out of the dialog.
- `src/tui/components/dialog/runs_dialog.tsx`, `src/tui/components/run_block.tsx` — absolute started times; shared step-state mapper import.
- `src/tui/components/tool_block.tsx` — inline-status prop; `src/tui/layout/message_block.tsx` — user-turn rule + prop pass-through.
- `src/tui/app.tsx` — sticky progress row, esc-selection layer; `src/tui/layout/status_bar.tsx` + `src/tui/layout/sidebar.tsx` — responsive path + label rows.
- `src/tui/components/list_core.tsx`, `fixed_list.tsx`, `dynamic_list.tsx`, `src/tui/app_config.tsx` — wrap-around navigation.
- `src/lib/design_system.ts` — breakpoint token; shared duration formatter home.
- `src/tui/layout/design_gallery.tsx` (+ fixtures) — new/updated exhibits for the sticky progress row, inline tool status, user-turn rule, and sidebar label rows.
- Tests: `list_primitives.render.test.tsx` (clamp assertion flips), `dialog_host.render.test.tsx` (config section clamp test), `sidebar_live.test.ts` (`profileDetailLines`), `sidebar.render.test.tsx`, new frame assertions for ToolBlock layout and the sticky row; `testRender`/`captureCharFrame` size sweeps for every relayout.
- `cli/CLAUDE.md` — the absolute-vs-relative time rule.
- Prerequisites (implemented, unarchived, untouched): `add-keymap-engine`, `add-workspace-context`.
