## Why

Pressing ⌘K in macOS Terminal.app while the chat is open blanks the entire UI and it stays blank — the only recovery is scrolling the terminal back up to find the old frame in scrollback, which reads as the app having navigated somewhere. ⌘K is an easy mis-keypress because the command palette is `ctrl+k`.

Two facts meet. Terminal.app's ⌘K is "Clear to Start" (`clearAll:`, not "Clear Scrollback"): it scrolls the visible screen — alternate screen included — into scrollback, and being a menu action it sends no bytes, raises no `SIGWINCH` and changes no focus state, so there is no signal to react to. And OpenTUI renders diffs against a shadow buffer of what it believes is on screen; measured in a pty on the pinned 0.4.2, an unchanged re-render emits zero bytes.

So every surviving cell reads as already-correct and is never rewritten: the chat renders correctly into a screen the terminal emptied. Recovery cannot be detected and must be user-triggered. See `design.md` for the measurements and the rejected alternatives.

## What Changes

- A new `screen-repaint` capability: a forced full repaint that invalidates the renderer's shadow buffer so the next frame rewrites every cell, reached by two paths.
- An explicit redraw key, `app.redraw` (default `ctrl+l`, the universal terminal redraw convention), registered on a **mode-less** layer so it survives an open modal — a redraw key that a modal suspends is useless exactly when a modal is what got wiped. Also reachable as `<leader>l`, which lists it in the which-key panel.
- An automatic heal: one forced repaint on the first keystroke after the keyboard has been idle for a threshold, so a user who knows nothing about redraw keys just presses something and the UI returns. A typing burst never crosses the threshold and so costs nothing.
- The repaint is guarded at the WIRE (a capturing stdout asserts a plain re-render emits zero bytes while a forced one re-emits the frame), because the only mechanism opentui exposes for this is a private field.

Deliberately out of scope, and specified as a known limitation rather than left implicit: damage that is never followed by a keystroke. Mid-turn, streamed output repaints only the cells it changes, so text appears on an otherwise blank screen until the user touches the keyboard. Closing that would need either a polling repaint (defeating on-demand rendering — the renderer costs no frames while idle) or a damage notification no terminal sends. Mouse input is likewise not a heal trigger.

## Capabilities

### New Capabilities

- `screen-repaint`: recovering the terminal surface after it is changed behind the renderer's back — the forced full repaint, the mode-less redraw key, the idle-gap automatic heal, and the wire-level guard over the private opentui mechanism.

### Modified Capabilities

None. `key-bindings` already covers what this change relies on: `app.redraw` joins `KEYBIND_DEFAULTS`, which the existing "User-remappable app keybindings" requirement governs generically without enumerating ids, and "Modal capture via a mode stack" already states that a layer omitting `mode` stays active in any mode.
