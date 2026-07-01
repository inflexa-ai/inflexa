# Add ScrollPane — reusable vim-key scroll component

## Why

Three TUI surfaces scroll under key control today, each with its own implementation and its own key set: the chat stream drives an unfocused scrollbox through a hand-wired `useBindings` layer (full vim set, 1-line steps), while `ResultsDialog` and `DesignGallery` focus their scrollbox and fall back to opentui's native handler (no `gg`/`G`/`ctrl+d`, 1/5-viewport steps). The same bindings are declared a third time inside `keymap_scroll.render.test.tsx`. The result is duplicated code and an inconsistent scroll feel across surfaces. Additionally, the chat's NORMAL mode is modeled as "no widget focused" — an implicit null state that already forced a `fallbackFocus` workaround into the dialog host's focus save/restore logic.

## What Changes

- New uncontrolled `ScrollPane` component in `src/tui/components/scroll_pane.tsx`: wraps opentui's `<scrollbox>`, owns its scroll state, and embeds one canonical vim key set (`gg` top, `G` bottom, `j`/`k` and up/down ±1 line, `ctrl+d`/`ctrl+u` ±half viewport, pgup/pgdn ±1 viewport, home/end) as a focus-target-gated keymap layer — keys are live exactly while the pane (or a descendant) is focused.
- Chat stream (`chat.tsx` / `app.tsx`), `ResultsDialog`, and `DesignGallery` migrate to `ScrollPane`; their hand-rolled scroll bindings and native-key reliance are removed. **BREAKING** (behavioral): dialog `j`/`k`/arrow steps change from 1/5-viewport to 1 line; dialogs gain `gg`/`G`/`ctrl+d`/`ctrl+u`.
- The cursor-driven hosts (`SelectList`, the config screen) also compose `ScrollPane` — as the plain scrollbox wrapper (`focusOnMount={false}`, never focused, keys dead) — so `<scrollbox>` appears nowhere outside the component.
- Chat NORMAL mode switches to focus-gating: `esc` focuses the scroll pane instead of blurring the textarea into a nothing-focused state; `i`/enter refocus the textarea. Focus is always on some widget.
- The dialog host's `fallbackFocus` machinery is deleted — with no nothing-focused state, saved focus is never `null` and restore is uniform.
- `keymap_scroll.render.test.tsx` is rewritten to drive the real `ScrollPane` component instead of re-declaring bindings inline.

## Capabilities

### New Capabilities

- `scroll-pane`: the reusable scroll surface — uncontrolled semantics, the canonical vim key set and step sizes, focus-target gating, native-handler shadowing (the layer's preventDefault suppresses opentui's 1/5-viewport handler), and sticky-scroll re-engagement on `G`.

### Modified Capabilities

- `tui-components`: `ResultsDialog` (and the gallery) scroll through `ScrollPane` rather than the native focused-scrollbox handler; the "scroll behaves exactly as before" wording in the relocated-dialog-widgets requirement is replaced by the `scroll-pane` contract.
- `tui-layout`: the chat shell's NORMAL mode becomes "scroll pane focused" (not "textarea blurred, nothing focused"); the dialog-close focus-restore contract simplifies to "restore whatever was focused" with no fallback branch.

## Impact

- **New**: `src/tui/components/scroll_pane.tsx`.
- **Modified**: `src/tui/components/chat.tsx`, `src/tui/app.tsx` (scroll layer and esc/i/enter wiring move out or shrink), `src/tui/components/dialog/results_dialog.tsx`, `src/tui/layout/design_gallery.tsx`, `src/tui/components/dialog/dialog_host.tsx` (fallbackFocus removal), `src/tui/keymap_scroll.render.test.tsx` (rewrite against the component).
- **No new dependencies**; builds on the existing keymap engine (`useBindings` focus-`target` scoping) and opentui scrollbox.
- Early-dev: no backwards-compatibility constraints; behavior changes listed above are accepted.
