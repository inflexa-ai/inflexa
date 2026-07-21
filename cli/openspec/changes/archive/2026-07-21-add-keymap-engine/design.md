## Context

`standardize-tui-layout` left `src/tui/keymap.ts` as a static `{ chord, label }` table. Matching was still hand-rolled per screen: `app.tsx` matched through the keymap, but `app_config.tsx` and the dialog widgets each owned a `useKeyboard` with `if (key.name === "…")` branches and hardcoded footer strings, so labels and matching could drift. This change ports OpenCode's declarative keymap engine (its `@opentui/keymap`, which is NOT a dependency here) to inflexa.

Key constraints:
- **No new dependencies** (CLAUDE.md) — the engine is built on opentui's existing `useKeyboard` bus.
- **`useKeyboard` is a global, focus-agnostic bus** — one root handler sees every keystroke regardless of focus. This is the load-bearing fact: it lets a single dispatcher arbitrate, and it is why a matched binding must `preventDefault()` so the focused textarea does not also consume it.
- **opentui is Solid, not React** — reactivity via signals; no re-renders.
- Verified opentui APIs: `renderer.currentFocusedRenderable`, `Renderable.findDescendantById`/`id`, `KeyEvent.eventType`/`preventDefault`, `useRenderer(): CliRenderer`.

## Goals / Non-Goals

**Goals:** bindings as declarative data dispatched centrally; modal capture without per-binding conditionals; remappable app keys; leader + chord sequences with live which-key docs; per-widget focus scoping; labels that cannot drift from matching.

**Non-Goals:** imperative plugin-lifetime layers (`registerLayer`) and a raw `intercept` pre-pass (no plugin host consumes them yet); a keybind-editing UI (remap via config file); OpenCode's paginated 3-column which-key widget (a simple grouped overlay fits ~6 leader bindings).

## Decisions

### Decision 1: Central dispatcher + a lazily-re-evaluated layer registry

Components call `useBindings(thunk)`; the registry stores the *thunk*, and the single root `useKeymapRoot()` dispatcher re-invokes it on every keystroke. That lazy re-evaluation IS the layer's reactivity — `enabled`/`mode`/`target` read fresh each press, with no `createEffect`/`createMemo` to keep in sync. A plain `Map` suffices because layers mutate only via mount/cleanup, never mid-dispatch.

*Alternative considered:* each component keeps its own `useKeyboard` and matches its own layer. Rejected — loses cross-layer arbitration (priority, mode gating) and re-creates the drift this change removes.

### Decision 2: Mode stack for modal capture (not per-binding `if (dialogOpen)`)

Base-UI layers tag `mode: MODE_BASE`; a dialog `pushMode(MODE_MODAL)` (an `App` effect tied to the dialog stack length) makes `currentMode()` return modal, so every base layer's filter fails at once. Dialog layers omit `mode` and stay live; the abort binding is mode-less + `priority: 100` so Ctrl+C still cancels a stream under a modal. The push effect re-runs on each length change (a nested open pops then re-pushes), so exactly one modal entry is ever on the stack.

### Decision 3: A timed multi-stroke sequence machine

`BoundBinding.chord` is a single `Chord` or a `Sequence`. The dispatcher keeps a `pending` prefix signal: a strict-prefix match holds the key (arming a `setTimeout(leaderTimeout)` that `unref`s so it never keeps the process alive), a full match runs and clears, and a key that matches neither abandons a pending sequence and retries alone. Escape clears the pending prefix; backspace pops one stroke. Full-match-first means a single-key binding that is also a prefix fires immediately — bindings must avoid that overlap (the leader is only ever a prefix, never a full binding).

### Decision 4: Focus `target` via the renderer's focused node

`useKeymapRoot` captures the renderer; a layer with `target` is gated by `isFocusedWithin(target, renderer.currentFocusedRenderable)`, which matches the target itself or any descendant (`findDescendantById`). This is the fine-grained complement to `mode` for the one-focus-slot screen — e.g. clear-input fires only while the chat textarea is focused.

### Decision 5: Labels derived from chords; app keys remappable, structural keys not

`chordLabel(chord)` is the only label source, so a chord and its hint cannot diverge. App-level keys live in `KEYBIND_DEFAULTS` (command id → key) and are remappable via `config.keybinds`, resolved once (a restart applies an edit — unlike the live-reactive theme) and cached to avoid a disk read per keystroke. Structural dialog keys (`KEYS`) are deliberately not remappable (the report's inline-`cmd` split). The textarea's submit/newline stay at the renderable level (`input_bar.tsx`) because they are cursor-aware actions the global engine cannot see; they still source their chords from `SUBMIT_CHORD`/`NEWLINE_CHORD` to keep one definition.
