## Why

The `standardize-tui-layout` change introduced `src/tui/keymap.ts` as a static `{ chord, label }` table, but matching stayed hand-rolled: each screen owned its own `useKeyboard` handler with `if (key.name === "…")` branches, and only `app.tsx` matched through the keymap. `app_config.tsx` and every dialog hardcoded both the key checks AND their footer strings, so labels and the real matching could silently drift (the keymap even admitted "config actions are label-only"). OpenCode's TUI solves this by making bindings *declarative data* dispatched by one engine; this change ports that engine to inflexa at the right altitude — turning the keymap module from a label table into the single keybinding engine for the whole TUI.

## What Changes

- Rebuild `src/tui/keymap.ts` into a **declarative keybinding engine**. A component declares a reactive layer with `useBindings(() => ({ enabled?, mode?, target?, priority?, bindings }))`; exactly one `useKeymapRoot()` per renderer installs the single `useKeyboard` that collects the active layers and routes each keystroke to the winning binding. No component writes a raw `useKeyboard`/`key.name === …` branch any more.
- **Modal capture via a mode stack.** A dialog `pushMode(MODE_MODAL)` (an `App` effect tied to the dialog stack) suspends every `MODE_BASE`-tagged layer at once — replacing the old per-handler `if (dialogOpen()) return`. The streaming-abort binding stays mode-less + high priority so Ctrl+C still cancels under a modal.
- **Leader key + multi-stroke chord sequences.** A configurable leader (`app.leader`, default `ctrl+x`) begins a timed sequence; `<leader>n` / `leaderSeq("n")` build multi-stroke bindings. Escape abandons a half-typed chord, backspace pops one stroke, and a comma denotes alternatives in a key spec.
- **A which-key panel** (`src/tui/layout/which_key.tsx`) auto-appears while a sequence is pending and lists every reachable next stroke, grouped, from the reactive `reachableKeys()` — free documentation, since each binding carries `desc`/`group`.
- **Per-widget focus `target` scoping.** A layer may carry `target: Renderable`; it is live only while that renderable (or a descendant) is focused — the fine-grained complement to `mode` (e.g. clear-input fires only when the chat textarea is focused).
- **Config-file remapping.** App-level keys are remappable via `config.keybinds` (command id → key string), resolved once over `KEYBIND_DEFAULTS`; unknown ids and unparseable values are ignored. `leaderTimeout` is configurable.
- **Labels are derived, not hand-kept.** Display labels come from `chordLabel(chord)`, so a chord is the single source and labels can never drift from matching. Structural dialog keys come from the shared `KEYS`; the chord matcher (`matchChord`) stays opentui-type-free — only the root handler + focus check touch opentui.
- Every consumer is routed through the engine: `app.tsx`, `app_config.tsx` (its own layer; installs the root only standalone), and the `select_list` / `results_dialog` / `prompt_dialog` widgets, whose footers now derive from the same chords. The textarea's submit/newline stay at the renderable level (`input_bar.tsx`, cursor-aware) but source their chords from `SUBMIT_CHORD`/`NEWLINE_CHORD`.

Non-goals (explicitly out): imperative plugin-lifetime layers (`registerLayer`) and a raw `intercept` pre-pass — there is no plugin host to consume them yet; a keybind-editing UI (remapping is via the config file, as in OpenCode); leader timeouts surfaced in the config screen.

## Capabilities

### Modified Capabilities
- `key-bindings`: The capability grows from a static `{ chord, label }` table into a declarative engine — reactive layers gated by `enabled`/`mode`/`target`/`priority`/`fallthrough`, a single central dispatcher, a mode stack for modal capture, a timed leader + multi-stroke chord sequences, a which-key panel reading reachable keys, focus-target scoping, and config-file remapping. Labels are derived from chords. The "imports no opentui APIs" constraint is relaxed to "the matcher stays opentui-free; only the root handler + focus check touch opentui."

## Impact

- **Code:** `src/tui/keymap.ts` rebuilt into the engine; new `src/tui/layout/which_key.tsx`; new `src/tui/keymap.test.ts`. `src/tui/app.tsx` installs the root, declares the abort/base/leader/clear-input layers, and pushes `MODE_MODAL` while a dialog is open. `src/tui/app_config.tsx` and `src/tui/components/{select_list,results_dialog,prompt_dialog}.tsx` declare layers instead of owning `useKeyboard`. `src/tui/layout/input_bar.tsx` sources its textarea chords from the keymap.
- **Config:** `src/lib/config.ts` gains optional `keybinds` (command id → key) and `leaderTimeout` (ms). Backward compatible — both are optional, existing config files still parse.
- **Docs:** `CLAUDE.md` gains a dedicated `src/tui/keymap.ts` engine bullet (and the lowercase/Ctrl-not-Alt rules move there).
- **Tests:** `bun test` covers chord parse/label round-trip, `parseKeySpec` (comma + leader), sequence pending→complete, escape-abort, backspace-pop, `reachableKeys`, `isFocusedWithin` ancestry, and dispatcher mode/enabled/priority/preventDefault/release.
- **No** new dependencies (the engine is built on opentui's existing `useKeyboard` bus). **No** DB/migration changes.
