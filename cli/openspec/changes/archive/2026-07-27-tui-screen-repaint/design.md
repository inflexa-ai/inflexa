## Context

The chat renderer runs in the alternate screen (`app.launch.tsx` passes `screenMode: "alternate-screen"`, confirmed on the wire — startup emits `CSI ?1049h`). OpenTUI's frame path ends in `lib.render(rendererPtr, force)`, where `force` comes from a private `forceFullRepaintRequested` field that the render loop reads once per frame and clears itself. With `force` false the native renderer diffs against its shadow buffer; measured in a pty, a re-render with unchanged content writes **0 bytes**.

Measurements this design rests on, all taken against the pinned `@opentui/core` 0.4.2 in a real pty at 200x50:

| Action | Bytes written | Notes |
|-|-|-|
| Startup frame | 13,333 | full paint, `CSI ?1049h` present |
| Re-render, nothing changed | **0** | the mechanism behind the bug |
| Forced full repaint | 13,048 | all rows repainted, wrapped in `CSI ?2026h` (synchronized output), stays in the alternate screen |
| `suspend()` + `resume()` | 6,761 | forces the repaint but emits `CSI ?1049l` then `CSI ?1049h` |
| `resize()` jiggle | 6,553 | forces the repaint, stays in the alternate screen |

Terminal.app's key equivalent was read from its own menu definition rather than inferred: `Clear to Start` carries the `k` equivalent and invokes `clearAll:`, while `Clear Scrollback` (`clearScrollback:`) has none and `Clear to Previous Mark` (`clearToSelectionOrMarker:`) takes `l`.

Established idioms this change composes (no new machinery):

- App-level reactive lifecycle hooks called from `App`'s setup under its reactive owner: `watchSidebarData`, `watchAgentModels`, `watchProfileParity` (`app.tsx:387-403`).
- Mode-less keymap layers for behavior that must survive a modal: the selection-clear layer and the streaming abort, both already specified in `key-bindings`.
- Remappable app keys as data in `KEYBIND_DEFAULTS`, with the display label derived from the chord.
- Injected seams so time-dependent logic is testable offline, as `WorkspaceSeams` does for locks and aborts.

## Goals / Non-Goals

**Goals.** Recover the surface without requiring the user to know anything. Cost nothing while idle (the renderer is on-demand; an idle chat must keep costing zero frames) and nothing during continuous typing. Survive an open modal. Fail loudly if the private mechanism it depends on stops working.

**Non-Goals.** Detecting the damage — no terminal reports it, and this design does not pretend otherwise. Healing on mouse input. Healing damage that is never followed by a keystroke. Making Terminal.app behave.

## Decisions

**D1 — Write the private `forceFullRepaintRequested` field.** There is no public equivalent: checked in the pinned 0.4.2 *and* in the current 0.4.5, neither of which exposes a repaint/redraw method (`forceFullRepaintRequested` is `private` in both `renderer.d.ts`). Sound because it is a plain boolean the render loop reads once per frame and clears itself, so writing it grants exactly the `force` argument the native renderer already takes, touching no other state.

The two public alternatives were both measured and rejected:

- `suspend()` + `resume()` sets the same flag, but leaves and re-enters the alternate screen. That is a visible flash, and on Terminal.app leaving the alternate screen dumps the frame into scrollback — it re-causes the very symptom being fixed.
- Jiggling `resize()` to a different size and back does force the repaint and stays in the alternate screen, but it relayouts the whole tree at a wrong size for one pass and emits spurious `resized` events that every `useTerminalDimensions` consumer observes. OpenTUI's yoga quirks are size-dependent, so a transient wrong size is not safe to inflict.

Accepted trade-off: an opentui upgrade can now *fail the build*. That is the intended failure mode and is why D4 exists. The durable resolution is upstream — a public repaint method.

**D2 — Trigger the automatic heal on an input-idle gap, not on every keystroke.** A forced repaint is ~13 KB at 200x50 and scales with terminal area, so forcing one per keystroke would multiply a keystroke's cost by orders of magnitude and defeat the diff renderer's purpose. The idle gap exploits the shape of the failure instead: a wipe is necessarily followed by a pause, because the user has to notice the blank screen, while continuous typing has inter-key gaps well under the threshold and so never pays. 500 ms sits above human typing cadence and far below how long someone stares at a broken screen.

Accepted trade-off: this is a heuristic about behavior, not a detection. Its cost lands on the first keystroke after any pause, which on a slow remote link is a perceptible hitch for a failure that is local to Terminal.app. Narrowing it by terminal identity (opentui exposes `capabilities.terminal`) was considered and rejected as fragile — multiplexers and other terminals damage screens too.

**D3 — Observe keypresses, do not bind them.** The heal subscribes to the key bus as a pure observer: it never inspects which key was pressed and never calls `preventDefault`. It is therefore not a binding and does not belong in the keymap engine, whose rule is that bindings are data dispatched centrally. The observer reliably sees every keystroke because the engine only ever calls `preventDefault` (which gates renderable handlers, not the other global listeners) and never `stopPropagation` on a keypress — so a key that a binding also consumes still heals.

**D4 — Guard the mechanism at the wire, not in memory.** Asserting that the renderer accepted and cleared the flag is not enough: a version that kept the field but stopped honoring it would pass every in-memory check and still ship a chat that never recovers. `testRender` accepts a custom `stdout` and defaults `bufferedOutput` to `"memory"`, so passing a capturing stream plus `bufferedOutput: "stdout"` makes the emitted bytes assertable. The test asserts a plain re-render emits zero bytes and a forced one re-emits the frame — which also pins the *premise* of the bug, so if opentui ever stops diffing, the suite says the recovery machinery can be reconsidered.

**D5 — Keep the redraw key mode-less.** Screen damage does not care whether a dialog is open, and the wiped surface may well be a modal. A full repaint is idempotent and touches no app state, so leaving it unsuspended is safe. Accepted trade-off: `ctrl+l` is now globally reserved at default priority, and since equal-priority layers tiebreak on registration order — and this layer registers during `App` setup, before any dialog mounts — a future dialog binding `ctrl+l` would silently lose rather than error.

## Risks

- **Masking our own rendering bugs.** If the TUI ever fails to invalidate a cell correctly, the heal quietly repairs it after any pause, making genuine diff bugs harder to notice and much harder to reproduce. This codebase already has a postmortem for a silent opentui render failure (`<For>`/`insertBefore`), so silent repair has a track record here. Accepted for the UX gain; noted so a future incident investigator knows to disable the heal while reproducing.
- **Mouse-first users get no heal.** Someone facing a blank screen may click before typing, and mouse events do not reach the keypress observer. Widening the observer to mouse input is a straightforward follow-up; the idle gap would bound its cost the same way.
