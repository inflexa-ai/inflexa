## Why

The chat TUI's shell (`app.tsx`) is one hand-rolled render tree: an inline header, an ad-hoc message loop, an input box, and no place to glance at the active analysis/anchor/session. `app_config.tsx` hand-rolls its own header too, so the two screens already drift. The "inf CLI Wireframes" design settles this with **Direction B — stream + toggleable sidebar** and a locked set of reusable shell parts. Standardizing on that kit now — before the richer "key moments" and more screens land — keeps every screen cohesive and makes the domain (analysis · anchor · session) glanceable.

## What Changes

- Introduce `src/tui/layout/` — the Direction-B composition kit: `status_bar.tsx`, `message_block.tsx`, `input_bar.tsx`, `sidebar.tsx`, and `markers.ts` (the shared gutter marker set). Plus a reactive `src/tui/hooks/status.ts` store holding the chat status. This is a deliberate, documented exception to the "don't extract single-caller sub-components" rule (like `app_config.tsx` is already an exception); `CLAUDE.md`'s Project-structure section is updated to document it.
- Recompose `app.tsx`: a persistent full-width **status bar** (left = `inf` + active analysis name; middle = live state ready/thinking/error, shown with a leading glyph and held in the `src/tui/hooks/status.ts` store — the app only renders it; right = global key hints), below it a **main row** = a **chat column** (the **stream** + error/notice + **input bar**, stacked) beside a **toggleable full-height sidebar**. The sidebar spans the full height alongside both the stream AND the input, so showing it shrinks the chat column horizontally (the opencode layout). When hidden the chat column spans full width.
- The **sidebar** renders all four wireframe sections. **SESSION** (short id · age · message count) and **ANALYSIS** (name · anchor path + ✓/⚠ marker badge · inputs · project) use real data. **CONTEXT** (tokens·%·$) and **RUNS** have no backing data model yet, so they render as explicit placeholders (`—` / "no runs yet"), never fabricated values. The sidebar is a fixed-width, full-height column (NOT mouse-resizable).
- Add a single **central keymap** (`src/tui/keymap.ts`). It defines each logical action's real chord plus a **platform-neutral, always-lowercase label** (`ctrl+k` / `ctrl+b` / `ctrl+c`, identical on every OS). Lowercase is a fixed rule for every keybind hint. It replaces today's scattered hardcoded hint strings and is the single source for every keybind hint. Global key hints live ONLY in the status bar; the input bar's footer shows hardcoded session/mode info (`INSERT` … `xhigh /effort`) instead, so the header and footer never repeat the same keys.
- Wire the **sidebar toggle** to `ctrl+b` in the chat's keyboard handler (gated while a dialog is open, with `preventDefault()` so the textarea doesn't eat it). Navigation chords are Ctrl, NOT Alt: terminals deliver Alt/Option unreliably (on macOS Option composes a character), which is why an Alt toggle did not fire for the user.
- `app_config.tsx` adopts the shared `StatusBar` (second real caller), replacing its hand-rolled header.

Non-goals (explicitly out): the 8 "key moments" stream block types (thinking / tool / run / diff / error-card / welcome), the ⌥R run monitor, and ^◄/^► session-switch keys. The input bar's mode-footer row IS rendered, but its content (`INSERT` … `xhigh /effort`) is hardcoded placeholder — the mode/effort features are not yet integrated. The full gutter marker set is defined as shared kit (`markers.ts`) but only `>`/`<` render until the key-moment blocks land. Only user/assistant text turns render through `message_block` in this change. No new theme tokens (all gutter-marker colors map onto existing roles), no new dependencies, no DB/migration changes.

## Capabilities

### New Capabilities
- `tui-layout`: The Direction-B app-shell composition kit under `src/tui/layout/` — the `layout/` membership rule, the status bar, the fixed-gutter message block, the input bar, and the toggleable four-section full-height sidebar (with honest placeholders for sections lacking a data model).
- `key-bindings`: A single keymap module that maps each logical action to its real chord and a platform-neutral, always-lowercase display label, and is the one source of keybind hint strings across the TUI.

### Modified Capabilities
- `command-palette`: The per-row keybind hints and the Ctrl+K invocation hint are sourced from the central keymap and rendered as lowercase labels; the actual chords (Ctrl+K to open, etc.) are unchanged.
- `tui-components`: The `components/` membership rule is refined so the layout composition kit lives in `src/tui/layout/`, distinguished by role (app-shell composition vs reusable widget) — a kit part such as `StatusBar` stays in `layout/` even though it is generic and multi-caller and would otherwise qualify for `components/`.

## Impact

- **Code:** new `src/tui/layout/{status_bar,message_block,input_bar,sidebar,markers}.{tsx,ts}`; new `src/tui/keymap.ts` + `src/tui/hooks/status.ts`; `src/tui/app.tsx` recomposed onto the kit with a full-height sidebar + `ctrl+b` toggle; `src/tui/app_config.tsx` adopts `StatusBar`; `src/tui/commands.tsx` + `src/tui/command_palette.tsx` read keybind labels from the keymap.
- **Data:** read-only — `listSessionMessages`, `getAnchor`/`resolveAnchor`, `listAnalysisInputs`, project lookup. No new queries, mutations, or migrations.
- **Docs:** `CLAUDE.md` Project-structure section documents `src/tui/layout/`.
- **No** new dependencies, **no** new theme tokens. CONTEXT and RUNS sidebar sections remain inert placeholders pending a future data-model change.
