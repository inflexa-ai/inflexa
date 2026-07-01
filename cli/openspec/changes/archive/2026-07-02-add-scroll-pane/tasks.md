# Tasks — add-scroll-pane

## 1. ScrollPane component

- [x] 1.1 Create `src/tui/components/scroll_pane.tsx`: uncontrolled `<scrollbox>` wrapper with `children`, `focusOnMount` (default true, `queueMicrotask` focus), `onRef` escape hatch, and layout passthrough (`stickyScroll`, `stickyStart`, padding, `flexGrow`, `width`)
- [x] 1.2 Register the internal `useBindings` layer gated by `target:` the own scrollbox: `gg` top, `G` bottom, `j`/`k` + arrows ±1 line, `ctrl+d`/`ctrl+u` ±½ viewport, pgdn/pgup ±1 viewport, end/home bottom/top — with `desc`/`group: "Scroll"` on the vim chords
- [x] 1.3 Implement bottom-scroll as `scrollTo(scrollHeight)` so `G`/end re-engage `stickyScroll`; verify the full native-answerable chord set is bound (nothing falls through to the 1/5-viewport native handler)
- [x] 1.4 Check focused-scrollbox visual styling (scrollbar/track tint) in the design gallery; neutralize via props or accept as the NORMAL-mode affordance (design D7 risk 1)

## 2. Host migrations

- [x] 2.1 Migrate `ResultsDialog`: render lines inside `ScrollPane`, delete its raw `<scrollbox>` + focus-on-mount code, derive the footer scroll hint from shared chord definitions via `chordLabel`
- [x] 2.2 Migrate `DesignGallery`: render the showcase inside `ScrollPane`, delete its raw `<scrollbox>` + focus-on-mount code
- [x] 2.3 Migrate the chat stream: `chat.tsx` renders `ScrollPane` (sticky-bottom, `focusOnMount={false}`, `onRef` handed up as today); delete the scroll-mode `useBindings` layer and `scrollToBottom` duplication in `app.tsx`
- [x] 2.4 Replace the remaining raw `<scrollbox>` usages (`select_list.tsx`, `app_config.tsx`) with `ScrollPane` as the plain wrapper: `focusOnMount={false}`, `scrollChildIntoView` via `onRef`, `minHeight` passthrough added — no `<scrollbox` JSX outside `scroll_pane.tsx`

## 3. Chat focus model (NORMAL = pane focused)

- [x] 3.1 Rewire `esc` in the textarea layer to `scrollPaneRef.focus()` (was `textareaRef.blur()`); add the chat-side companion layer gated `target:` the pane with `i`/enter → `textareaRef.focus()`; ensure `esc` on the focused pane is a no-op
- [x] 3.2 Delete the `inputFocused` signal's role as scroll gate in `app.tsx` (the `enabled: !inputFocused()` layer is gone); confirm the ChatBar INSERT/NORMAL footer still tracks textarea focus events unchanged
- [x] 3.3 Delete `fallbackFocus` from `dialog_host.tsx` (prop, null-restore branch) and its wiring in `app.tsx`; restore path becomes capture-on-first-open / refocus-if-in-tree-on-last-close

## 4. Tests & verification

- [x] 4.1 Rewrite `keymap_scroll.render.test.tsx` against `ScrollPane`: mount with a sibling input via `testRender`; assert canonical steps for `j`/`k`/`ctrl+d`/pgdn/`gg`/`G`, focus gating (keys dead while input focused), and sticky re-engagement after `G`
- [x] 4.2 Add dialog-restore coverage: open a dialog from NORMAL mode (pane focused), close it, assert focus returns to the pane with scroll keys live
- [x] 4.3 Run `bun run typecheck`, `bun run lint`, full test suite; run `bun run format:file` on all touched `src/` files
- [x] 4.4 Manual pass in the real TUI (chat: esc/j/k/gg/G/i; ResultsDialog + gallery scroll; dialog open/close focus restore) and gallery review of pane focus styling
