## 1. The engine core (`src/tui/keymap.ts`)

- [x] 1.1 Keep `Chord`/`KeyLike` + a structural `matchChord`; add `eventChord`/`chordEq` and sequence helpers (`isPrefix`/`isStrictPrefix`/`seqEq`). The matcher stays opentui-type-free.
- [x] 1.2 Add `parseChord` (with a friendly→canonical alias map) and `parseKeySpec` (comma = alternatives, `<leader>` token, space = multi-stroke) returning `Sequence[]`. Derive labels with `chordLabel` / `sequenceLabel` (arrows via `GLYPHS`, always lowercase).
- [x] 1.3 Add the shared `KEYS` (non-remappable structural chords) and `SUBMIT_CHORD`/`NEWLINE_CHORD`.
- [x] 1.4 Add `KEYBIND_DEFAULTS` (command id → default key) + a load-once resolver merging `config.keybinds` over defaults; expose `resolveKeybind`/`keybindLabel`/`leaderChord`/`leaderSeq`.

## 2. Layers, modes, dispatch

- [x] 2.1 Implement the mode stack: `MODE_BASE`/`MODE_MODAL`, `currentMode()`, `pushMode()` returning a token-scoped pop disposer.
- [x] 2.2 Implement the layer registry: `useBindings(thunk)` (re-read per keystroke for reactivity, `onCleanup` deregisters) and `activeLayers()` filtering by `enabled`/`mode`/focus `target`, sorted by `priority`.
- [x] 2.3 Implement `dispatchKey`: ignore `release` events; honor a pending sequence (escape abandons, backspace pops); run full matches (stop at first non-`fallthrough`), hold strict-prefix matches as pending with a timed `setTimeout`, and retry a broken sequence's key alone.
- [x] 2.4 Implement focus targets: capture the renderer in `useKeymapRoot`, gate via `isFocusedWithin(target, renderer.currentFocusedRenderable)`.
- [x] 2.5 Expose which-key selectors: `pendingSequence()`, `leaderActive()`, `reachableKeys()` (deduped next strokes with `desc`/`group`/`continues`).
- [x] 2.6 `useKeymapRoot()` installs the single `useKeyboard` and captures/clears the renderer on cleanup.

## 3. which-key panel (`src/tui/layout/which_key.tsx`)

- [x] 3.1 Create `WhichKey`: a `<Show when={leaderActive()}>` docked overlay listing `reachableKeys()` grouped (continues-first within a group), titled with the pending sequence label. Colors via `theme()`, glyphs via `GLYPHS`, `zIndex.popover`.

## 4. Config (`src/lib/config.ts`)

- [x] 4.1 Add optional `keybinds: Record<string,string>` and `leaderTimeout: number` (default 2000) to the schema + fallback object. Both optional — existing config files still parse.

## 5. Route every consumer through the engine

- [x] 5.1 `app.tsx`: `useKeymapRoot()`; an always-on high-priority abort layer (enabled while busy); a `MODE_BASE` layer with direct + `<leader>` bindings (`desc`/`group` feed which-key); a `target`-scoped clear-input layer; and a `createEffect` that pushes `MODE_MODAL` while the dialog stack is non-empty. Render `<WhichKey/>`.
- [x] 5.2 `app_config.tsx`: declare a bindings layer (q/esc/ctrl+c exit-confirm, s save, space/enter toggle, arrows nav); install `useKeymapRoot()` ONLY when standalone (`!props.onClose`) so the embedded screen does not double-dispatch.
- [x] 5.3 `select_list.tsx` / `results_dialog.tsx` / `prompt_dialog.tsx`: replace each `useKeyboard` with a `useBindings` layer; derive footers from the same `KEYS` chords via `chordLabel`.
- [x] 5.4 `input_bar.tsx`: source the textarea `KeyBinding[]` from `SUBMIT_CHORD`/`NEWLINE_CHORD` (stays renderable-level, cursor-aware).
- [x] 5.5 `commands.tsx`: quit's display hint via `keybindLabel("app.abort")`.

## 6. Tests, docs, verification

- [x] 6.1 `src/tui/keymap.test.ts`: chord parse/label round-trip; `parseKeySpec` (comma + leader + multi-stroke); `matchChord` (alt from option OR meta); dispatcher mode/enabled/priority/preventDefault/release; sequence pending→complete; escape-abort; backspace-pop; `reachableKeys`; `isFocusedWithin` ancestry.
- [x] 6.2 `CLAUDE.md`: add a dedicated `src/tui/keymap.ts` engine bullet; move the lowercase / Ctrl-not-Alt rules there.
- [x] 6.3 `bun run typecheck` + `bun run lint` (0 warnings) + `bun test` (all pass) + `bun run format:file` on changed `src/` files.
- [ ] 6.4 Manually verify in `bun run dev`: `ctrl+k` opens the palette and `ctrl+x` shows the which-key menu (then `n`/`t`/`q` …); opening a dialog suspends the base keys; `ctrl+u` clears the input only while the textarea is focused; `esc` aborts a half-typed leader chord.
