## Context

The TUI has four input surfaces that each hand-wire the same opentui primitives (`<input>`, `<textarea>`) with identical theme color props and independently reinvented keybinding logic:

- **InputBar** (`layout/input_bar.tsx`) — chat textarea with border, INSERT/NORMAL footer, renderable-level submit/newline chords
- **SelectList** (`components/select_list.tsx`) — single-line `<input>` with per-keystroke `onInput` for fuzzy filtering
- **PromptDialog** (`components/dialog/prompt_dialog.tsx`) — textarea with configurable height, keymap-engine submit
- **ExportOptionsDialog** (`components/dialog/export_options_dialog.tsx`) — textarea (height=3) inside a form

All four repeat `textColor={theme().fg}`, `placeholderColor={theme().fgMuted}`, `backgroundColor={theme().bg}`, `focusedBackgroundColor={theme().bgActive}`. The user encounters different submit behaviors, different mode indicators, and different visual treatments across contexts.

## Goals / Non-Goals

**Goals:**
- Single source for themed input styling (colors, placeholder, background)
- Consistent INSERT/NORMAL mode signaling across input contexts via border color
- A compact chrome tier that shows mode without consuming an extra row
- Reusable TextArea and TextInput primitives that existing dialogs and the chat bar compose
- Design gallery coverage for both components in all states

**Non-Goals:**
- Changing the keymap engine architecture — submit/newline routing strategy stays as-is per component
- Adding new keybindings or mode behaviors beyond what InputBar already has
- Making TextInput (the `<input>` wrapper) mode-aware — the filter/search pattern has no NORMAL concept
- Mouse-based mode switching or click-to-focus interactions
- Scroll-mode vim key behavior (that stays in the app shell)

## Decisions

### Decision 1: Two components, not one

**TextArea** wraps `<textarea>`, **TextInput** wraps `<input>`. A single component with an `element` prop was considered and rejected because the behavioral contracts are fundamentally different: TextArea has a buffer→submit model with INSERT/NORMAL mode, submit/newline chords, and multi-line support. TextInput has a per-keystroke `onInput` model with no mode concept. An `element` prop would gate entirely different logic paths throughout the component body — two components with a shared visual contract is cleaner.

### Decision 2: Three chrome tiers via a `chrome` prop

- **`"full"`** — bordered box + external footer row with mode word + keybind hints. Only used by ChatBar.
- **`"compact"`** — bordered box with mode word rendered in the border title via opentui's `title`/`titleColor` box props (same mechanism as DialogPanel). No footer row. Saves one row of vertical space.
- **`"bare"`** — no border, no mode text display. Mode signal is background color only (`bgActive` → `bg`).

Alternative considered: a boolean `showFooter` + boolean `showBorder`. Rejected because the three tiers are a named vocabulary (not arbitrary flag combinations), and they compose cleanly — `compact` isn't just "full minus footer", it also moves the mode indicator into the border chrome.

### Decision 3: Mode signal via border color across all tiers

The border color shift (INSERT → `borderFocus`, NORMAL → `border`) signals mode across all bordered tiers. INSERT uses the active/focused border; NORMAL uses the default border — a dimmed, resting state that matches the old InputBar's unfocused appearance:

| Tier | INSERT signal | NORMAL signal |
|------|--------------|---------------|
| full | `borderFocus` border + footer says INSERT | `border` border + footer says NORMAL + `bgActive` background |
| compact | `borderFocus` border + title says "INSERT" (right-aligned) | `border` border + title says "NORMAL" in accent (right-aligned) |
| bare | `bgActive` background | `bg` background |

For bare (no border), the background color is the sole signal — opentui's `focusedBackgroundColor` vs `backgroundColor` handles this natively.

### Decision 4: TextArea owns submit/newline at the renderable level

Submit (Enter) and newline (Ctrl+J) stay as renderable-level `keyBindings[]` on the `<textarea>`, not routed through the keymap engine. These are cursor-aware editing actions the engine can't see (the InputBar comment at line 21-25 documents this rationale). This means PromptDialog and ExportOptionsDialog will switch from keymap-engine enter-to-submit to renderable-level — a behavioral unification, not a regression. The chords are still sourced from `SUBMIT_CHORD`/`NEWLINE_CHORD` in `keymap.ts`.

### Decision 5: ChatBar composes TextArea, not the reverse

`ChatBar` (`layout/chat_bar.tsx`, renamed from `input_bar.tsx`) is a layout-kit part that composes `TextArea` with `chrome="full"` and adds the external footer row. TextArea is a reusable component in `components/`; ChatBar is app-shell composition in `layout/`. This follows the existing `components/` vs `layout/` split.

### Decision 6: TextInput has no mode concept

The `<input>` element serves filter/search patterns where the user is always typing. There is no "scroll mode" to blur into — esc closes the enclosing dialog/palette. If a future surface needs an `<input>` with mode tracking, it can be added then; designing for it now would be speculative.

## Risks / Trade-offs

- **PromptDialog submit mechanism change** — switching from keymap-engine `useBindings` enter-to-submit to renderable-level `keyBindings[]`. Risk: the WhichKey overlay will no longer document the "enter to submit" binding for prompt dialogs. Mitigation: prompt dialogs already show a footer hint (`enter submit · esc cancel`) via DialogPanel, so the user still sees the affordance. The WhichKey overlay is primarily useful for global/app-level bindings, not dialog-scoped ones.

- **ExportOptionsDialog tab-cycling interaction** — the dialog tab-cycles between a text field and checkbox options. TextArea's submit chord (Enter) must not fire when the text field is blurred (focus is on a checkbox). Mitigation: TextArea's renderable-level `onSubmit` only fires when the textarea has focus, which it doesn't when tab has moved to an option. The existing form's confirm-on-enter must stay in the keymap engine for the non-textarea state.

- **Rename from InputBar → ChatBar** — all importers must update. Risk: a missed import breaks the build. Mitigation: TypeScript's `tsc --noEmit` catches any broken import immediately. Only `app.tsx` imports InputBar today.

## Open Questions

None — all design decisions were confirmed in the explore session.
