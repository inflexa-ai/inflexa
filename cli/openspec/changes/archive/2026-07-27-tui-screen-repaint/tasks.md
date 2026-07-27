## 1. The repaint mechanism (`src/tui/hooks/repaint.ts`)

- [x] 1.1 Add `forceFullRepaint(renderer)` invalidating the renderer's shadow buffer and requesting a frame (`repaint.ts:29`); document at the site why the private `forceFullRepaintRequested` field is the only available mechanism (no public equivalent in the pinned 0.4.2 nor in 0.4.5) and why `suspend()`/`resume()` and a `resize()` jiggle were measured and rejected, per design D1
- [x] 1.2 Add `REPAINT_IDLE_GAP_MS = 500` with the reasoning for the value — above human typing cadence, far below how long a user stares at a wrong display (`repaint.ts:56`)
- [x] 1.3 Add `watchScreenDamage(renderer, opts?)` forcing one repaint on the first keypress after the idle gap, subscribing to the key bus as a pure OBSERVER (no key identity inspected, no `preventDefault`) with `onCleanup` teardown and an injectable `now` seam (`repaint.ts:78`), per design D2/D3
- [x] 1.4 Record the module-level rationale: the diff-render mechanism, Terminal.app's ⌘K being `clearAll:` ("Clear to Start", not "Clear Scrollback"), the absence of any damage signal, and the stated limitation that damage never followed by a keystroke stays unrepaired

## 2. Keybinding + wiring

- [x] 2.1 Add `"app.redraw": "ctrl+l"` to `KEYBIND_DEFAULTS` with the convention rationale, having verified the chord is unclaimed by every layer and by the textarea's own bindings (`keymap.ts:248`)
- [x] 2.2 Register the redraw binding on a MODE-LESS layer in `App` so it survives an open modal, documenting why (`app.tsx:677`), per design D5
- [x] 2.3 Add the `<leader>l` sequence with a `desc`/`group` so the redraw is listed in the which-key panel (`app.tsx:704`)
- [x] 2.4 Call `watchScreenDamage(renderer)` from `App`'s setup beside the other `watch*` lifecycle hooks, under its reactive owner (`app.tsx:403`)

## 3. Tests (`src/tui/repaint.render.test.tsx`)

- [x] 3.1 Wire-level guard over a capturing stdout (`bufferedOutput: "stdout"`, `screenMode: "alternate-screen"`): a plain re-render emits ZERO bytes while a forced one re-emits the frame — pinning both the fix and the premise of the bug, per design D4
- [x] 3.2 Presence guard: the private field exists on a real renderer and is a boolean, so a rename fails the suite rather than reverting the fix to a silent no-op
- [x] 3.3 One-shot guard: the renderer consumes and clears the flag, so repeated forcing cannot wedge it into permanent full frames
- [x] 3.4 End-to-end through the REAL keymap engine: `ctrl+l` forces the repaint, and still does with `MODE_MODAL` pushed — asserted alongside a base-mode binding proven to fire without the modal and not fire under it, so the modelessness claim is not vacuous
- [x] 3.5 Heal behavior with an injected clock: fires on the first key after the gap, does not fire during a burst inside the gap, and fires for a key a binding also consumes
- [x] 3.6 Verify the guards actually bite by removing the field write and confirming the suite fails (mutation check), then restore

## 4. Verification

- [x] 4.1 `bun run typecheck`, `bun run lint`, and `bun run format:file` on every touched `src/` file
- [x] 4.2 Full `bun test` in `cli/`, compared against a stashed baseline to confirm the 36 pre-existing failures are unchanged and unrelated (harness-provenance, agent-switch, e2e spawn)
- [x] 4.3 Confirm the shipped module end-to-end in a real pty with genuine keystrokes and real timing: zero bytes while idle, a full repaint on one keystroke after a pause, no forced repaints during a 5-key burst
- [x] 4.4 Record the postmortem in `HORRIBLE_BUG_FIXES.md` per the repo convention for hard-won renderer lessons

## Follow-ups

Deliberately out of scope here, recorded so the gaps are not rediscovered as surprises (see `design.md` → Decisions, Risks). These are not tasks of this change:

- Widen the heal observer to mouse input, so a user who clicks before typing also recovers.
- Raise an upstream request for a public repaint method on `CliRenderer`, which would retire the private-field dependency entirely.
