# Design — add-scroll-pane

## Context

Three free-scroll surfaces exist (chat stream, `ResultsDialog`, `DesignGallery`) plus a test that re-declares the chat's bindings. Two dispatch mechanisms are in play:

- **Keymap layer, unfocused scrollbox** (chat, `app.tsx:186-203`): full vim set driven by ref method calls, gated on `enabled: !inputFocused()`. Works because the textarea owns focus and NORMAL mode is "textarea blurred".
- **Native focused-scrollbox handler** (dialogs): opentui's `ScrollBarRenderable.handleKeyPress` hardcodes `j`/`k`/arrows at 1/5-viewport, pgup/pgdn at 1/2-viewport, home/end. No `gg`/`G`, no `ctrl+d`/`ctrl+u`, no way to restyle steps.

Two engine facts (verified against `@opentui/core` source and `keymap.ts`) shape the design:

1. A matched keymap binding calls `preventDefault` by default (`keymap.ts` root dispatch), and opentui only invokes a focused renderable's native `handleKeyPress` when `!key.defaultPrevented`. A keymap layer therefore cleanly **shadows** the native handler for every chord it binds — but unbound keys fall through to the native handler at its own step sizes.
2. The keymap's layer gating composes `enabled` + `mode` + focus-`target` in one filter, so a single component-internal layer can serve both dialog hosts (target-gating) and any future custom gating without API changes.

The chat's NORMAL mode being "nothing focused" already leaked complexity: `dialog_host.tsx` grew a `fallbackFocus` prop and a three-way restore branch specifically because saved focus can be `null` when a dialog opens from NORMAL mode.

## Goals / Non-Goals

**Goals:**

- One canonical scroll key set with one set of step sizes, owned by one component.
- Uncontrolled semantics: drop `ScrollPane` in with children; scroll position and key handling are internal. Hosts need zero keymap wiring.
- Focus decides key ownership — the same model the engine (focus-`target`) and opentui (focused-renderable dispatch) already use.
- Focus is always on some widget; delete the `fallbackFocus` special case.

**Non-Goals:**

- Changing the cursor-driven interaction model (`select_list.tsx`, `app_config.tsx` section nav): keys move a selection cursor and `scrollChildIntoView` follows. These hosts DO compose `ScrollPane` — as the single `<scrollbox>` wrapper, with `focusOnMount={false}` and the pane never focused, so its key layer never engages — but their cursor semantics are untouched (user-requested widening: no raw `<scrollbox>` anywhere outside the component).
- Horizontal scrolling (`h`/`l`): no horizontal surface exists; not bound.
- User-remappable scroll keys (`config.keybinds`): scroll chords are structural, like dialog keys. Can be revisited if asked for.
- Preserving current dialog scroll step sizes or the chat's blur-based NORMAL mode — early dev, breakage accepted (proposal).

## Decisions

### D1: Component name — `ScrollPane` in `src/tui/components/scroll_pane.tsx`

opentui owns "scrollbox" (the JSX intrinsic and `ScrollBoxRenderable`); reusing the name would make call sites ambiguous. "Pane" captures the new role: a focusable surface that owns the keyboard while focused. Alternatives: `Scrollable` (adjective, reads poorly as a component), `VimScroll` (names the mechanism, not the thing).

Membership check: imports only keymap + opentui/solid (the same import shape as `results_dialog.tsx`) and has three callers — a valid `components/` citizen.

### D2: Keys embed as a component-internal `useBindings` layer gated by `target: <own scrollbox>`

The component registers one layer with the canonical set; `target` gates it to when its scrollbox (or a descendant) is focused. This follows the `CLAUDE.md` keymap rule (bindings are data; no raw `useKeyboard` in components) and gives per-instance disambiguation for free: with two panes mounted, focus picks which one scrolls. Bindings carry `desc`/`group: "Scroll"` so WhichKey documents them exactly when they are live.

Alternative considered — `enabled` accessor prop (the chat's current model): rejected as the default because it cannot disambiguate two mounted panes and it leaks keymap concepts into the component API. No `enabled`/`mode` props are exposed initially; add them only when a real host needs them.

### D3: Canonical key set and step sizes

| Chord | Action |
|---|---|
| `gg` (sequence) | top (`scrollTo(0)`) |
| `G` (shift+g) | bottom (`scrollTo(scrollHeight)`) — re-engages `stickyScroll` |
| `j` / `k`, down / up | ±1 line (`scrollBy(±1)`) |
| `ctrl+d` / `ctrl+u` | ±½ viewport (`scrollBy(±0.5, "viewport")`) |
| pgdn / pgup | ±1 viewport (`scrollBy(±1, "viewport")`) |
| end / home | bottom / top |

Vim convention (user-confirmed). Line-step for `j`/`k` matches the chat's current feel and reads better than the native 1/5-viewport jump. home/end are bound **deliberately** so they don't fall through to the native handler (engine fact 1: only bound chords are shadowed). This is the full set the native handler could otherwise answer for; nothing falls through.

### D4: Uncontrolled component; minimal API

```
ScrollPane props:
  children
  focusOnMount?: boolean (default true)   — dialogs keep today's focus-on-mount
  onRef?: (r: ScrollBoxRenderable) => void — escape hatch (chat's external
                                             scrollToBottom on send, tests)
  + layout passthrough: stickyScroll?, stickyStart?, padding*, flexGrow?, width?…
```

Scroll position lives in the renderable; key handling lives in the internal layer. The one imperative need a host has (chat re-engaging bottom-stick when a message is sent) goes through `onRef` — the same escape-hatch pattern as `TextArea.onRef`.

### D5: Chat NORMAL mode = scroll pane focused

`esc` (textarea layer) calls `scrollPaneRef.focus()` instead of `textareaRef.blur()`. A small chat-side companion layer, gated `target: scrollPaneRef`, binds `i`/enter → `textareaRef.focus()` (returning to INSERT is chat-specific; dialogs have no input to return to). The `inputFocused` signal and the `enabled: !inputFocused()` scroll layer in `app.tsx` are deleted — ChatBar's INSERT/NORMAL footer keeps working untouched because it derives from the textarea's own focused/blurred renderable events.

`esc` while the pane is focused is a **no-op** in the chat (it must not blur into a nothing-focused state). In dialogs, esc/q close the dialog via the dialog's own bindings, as today.

Clicking the stream does not focus the pane (click-to-focus stays opt-in per component, as with `TextArea`); mouse wheel scrolling is position-routed and works regardless of focus.

### D6: Delete `fallbackFocus`

With NORMAL mode focusing the pane, focus is always on some renderable, so the dialog host's saved focus is never `null`. The `fallbackFocus` prop, its `app.tsx` wiring, and the null-restore branch in `dialog_host.tsx` are removed; restore becomes "blur on first open, refocus saved renderable (if still in tree) on last close". If the saved renderable left the tree, focus falls wherever the host screen puts it on next interaction — acceptable; no fabricated fallback.

### D7: Test strategy

`keymap_scroll.render.test.tsx` is rewritten to mount `ScrollPane` (with a sibling input to prove gating) via `testRender`/`captureCharFrame` + `mockInput.pressKeys`, asserting: `gg`/`G`/`j`/`k`/`ctrl+d`/pgdn move `scrollTop` with the canonical step sizes; keys are dead while the input is focused; `G` re-engages sticky bottom. The dialog hosts get no new per-host scroll tests — the component test is the single behavioral source, mirroring how `select_list` modes are tested once.

## Risks / Trade-offs

- [Focused scrollbox may render focus styling (scrollbar/track tint), repainting the stream on esc] → Check `ScrollBoxRenderable`'s focused visuals during implementation; neutralize via props if the change is unwanted, or keep it as a deliberate NORMAL-mode affordance (decide at gallery review).
- [Unbound keys reach the native handler while focused] → D3 binds the complete native-answerable set; any future native additions in opentui upgrades could reintroduce fallthrough — acceptable, revisit on upgrade.
- [Two panes + WhichKey: duplicate "Scroll" entries if both targets are focused-adjacent] → target-gating means at most one pane's layer is active at a time (focus is single); no dedup needed.
- [Chat esc currently also has meaning during streaming (abort is a separate key)] → esc→focus-pane touches only the textarea layer's esc binding; abort wiring is untouched.
- [`fallbackFocus` deletion strands focus if the saved renderable was unmounted while a dialog was open] → restore already verifies tree membership; the stranded case requires the host screen to have swapped its content under a dialog, which no current flow does.

## Open Questions

None blocking. Focus styling (risk 1) is decided during implementation with the gallery open.
