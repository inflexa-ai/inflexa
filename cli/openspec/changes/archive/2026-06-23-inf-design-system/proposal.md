## Why

The "inf Design System" formalizes a character-grid design language for the opentui + solid.js agent TUI: one shell, a fixed block vocabulary, semantic color roles, and named layout constants. Most of the *shell* already ships, but three foundations are missing or inconsistent — the color-role vocabulary is ad-hoc (only 2 of the standard 3 foreground tiers, no on-color role), there are no named layout/spacing tokens (magic numbers inline), and 6 of the 8 canonical stream-block states are unbuilt. This change lands the full system so every screen the agent renders stays cohesive and re-skins from one role table.

## What Changes

- **Color roles realigned to a standards-grounded vocabulary** (researched against Material 3, MUI, GitHub Primer, IBM Carbon, Catppuccin, Radix). Adopt a Primer/Carbon-style functional set across all 10 themes and every call site. **BREAKING** (internal): token renames `bgPanel→bgRaised`, `bgFocused→bgActive`, `muted→fgMuted`, `borderActive→borderFocus`, `warn→warning`; `selected` folded into `bgActive`. New roles `fgSubtle` (the standard 3rd foreground tier), `onAccent` (text/icon on a filled accent/status background), and dedicated domain roles `tool` and `thinking`. The design doc's own names (`ok`/`danger`/`id`) were deliberately **not** adopted — they are less standard than the existing names.
- **Layout tokens introduced** — a new `src/tui/tokens.ts` exposing `space` (none/sm/md/lg), `size` (gutter/statusBar/railWidth/composerMin/paletteRows), and `stroke` (panel/overlay/focus/danger) as `as const` literal-typed constants. Inline layout integers (sidebar width, paddings, input min/max height, gutter) refactor to tokens. The rail keeps its current tuned width (40 cells), not the doc's example 30.
- **All 8 canonical stream-block states rendered** — welcome/startup, plain chat (exists), thinking/reasoning, tool-call & result, long-running run/task, diff/file-edit, error/abort, command palette (exists). Each is a gutter-marked block mapping to a built-in opentui renderable.
- **Mock data models added** so the not-yet-real blocks render faithfully — the `Part` union grows mock thinking / tool-call / file-edit kinds; new mock `Run`/`Step` and token-cost models with sample fixtures drive the run block and the sidebar's RUNS and CONTEXT slots (replacing the em-dash placeholders). All mock data is clearly marked as sample, never fabricated as if live. The live chat engine is **not** wired to emit these — that is a deliberate follow-up.
- **`onAccent` applied** to the error banner and status fills, replacing the current background-reuse hack (`fg={theme().bg}` over a filled background).
- **Type & emphasis vocabulary adopted** — the design's scale is exposed as inline JSX components in `src/tui/components/emphasis.tsx` (`<Bold>`, `<Italic>`, `<Underline>`, `<Dim>`, `<Reverse>`, `<Fg role={…}>`), each wrapping an opentui span; call sites use the components and only `emphasis.tsx` touches the low-level `t`/`fg`/`bold`/… primitives. Their semantic mapping (names · body · meta · reasoning · paths · selection) is a `CLAUDE.md` reference table (no wrapper re-export module). This replaces the `<span style={{ fg }}>` segments and the magic `attributes={1}`/`{4}` literals across the TUI, and routes selection / cursor highlighting (the focused config section, …) through `<Reverse>` — an explicit fg/bg swap (the `inverse` attribute bakes to an invisible block; opentui's `reverse()` helper is broken).
- **Keybindings unchanged** — the existing keymap engine stays; the doc's `^S`/`^R`/`^◄►` table is aspirational and out of scope.

## Capabilities

### New Capabilities
- `tui-design-tokens`: named layout/spacing/stroke constants in `src/tui/tokens.ts`; layout props use tokens rather than raw integers.
- `tui-stream-blocks`: the eight-state gutter-marked stream-block vocabulary and its block renderers, each mapping to a built-in renderable, with the per-block affordances (collapse/expand reasoning, accept/reject diff, detach/abort run).
- `tui-mock-data`: mock data models (extended `Part` kinds, `Run`/`Step`, token-cost context) and sample fixtures, explicitly marked as mock, feeding the new blocks and the sidebar's RUNS/CONTEXT slots.
- `tui-text-emphasis`: the design's "Type & emphasis" vocabulary as inline JSX components (`<Bold>`/`<Italic>`/`<Underline>`/`<Dim>`/`<Reverse>`/`<Fg>`) in `src/tui/components/emphasis.tsx`, with their semantic mapping (names · body · meta · reasoning · paths · selection) documented as a `CLAUDE.md` reference table (no wrapper re-export module). Selection / cursor highlighting routes through `<Reverse>`.

### Modified Capabilities
- `theme-system`: the semantic token vocabulary is realigned (renames + new `fgSubtle`/`onAccent`/`tool`/`thinking` roles), superseding the prior "existing token names unchanged" requirement.
- `tui-layout`: the rail width becomes `size.railWidth`, and the sidebar's CONTEXT and RUNS slots render mock data instead of em-dash placeholders.

## Impact

- **Code**: `src/lib/themes.ts` (all 10 theme palettes + `ThemeColors`), `src/tui/theme.ts` (notice mapping), every `theme().<role>` call site across `src/tui/`, new `src/tui/tokens.ts`, new block widgets under `src/tui/components/` (thinking/tool/diff/run/error/welcome) + `src/tui/design_gallery.tsx`, `src/tui/markers.ts` (relocated from `layout/` so `components/` can import it), `src/types/session.ts` (Part union) + `src/tui/mock_fixtures.ts`, `src/tui/layout/message_block.tsx` (the Part→widget mapper), `src/tui/layout/sidebar.tsx`, `src/tui/components/chat.tsx`, `src/tui/commands.tsx` (gallery command).
- **No new dependencies.** No persistence/migration changes (mock data is in-memory fixtures). No change to the keymap engine, the chat-wiring/event-bus, or any non-TUI command path.
- **Risk**: a wide mechanical rename across 10 themes and many call sites; mitigated by the type system (a missing/renamed token fails `tsc`).
