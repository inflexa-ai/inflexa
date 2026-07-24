## Why

Answering a docked approval prompt today requires focusing the prompt card first (a click on the card) and then pressing a bare `y`/`a`/`n` key — the focus gate that makes bare printables legal also makes the two most natural interactions dead ends: clicking an option label directly does nothing, and typing `y` into the chat composer is silently swallowed by the busy-turn submit gate. Both dead ends read as the TUI ignoring the user at the exact moment it is blocked waiting on them.

## What Changes

- The docked ask prompt's choice options (`y approve`, `a always`, `n reject`) become individually mouse-activatable: a click on an option answers as if its key had been pressed. Activation is on mouse-up, guarded against text-selection drag releases, and inert in design-gallery exhibits.
- While an ask is docked, the chat composer becomes a second answer path: submitting exactly `y`, `a`, or `n` (trimmed, case-insensitive) answers the head ask through the same gateway funnel, clears the buffer, and the existing drain choreography restores NORMAL / the next prompt. Bare `n` rejects with no feedback (composer-carried reject feedback is deliberately out of scope, tracked as a follow-up issue).
- Submitting any other text while an ask is docked keeps today's refusal (draft preserved) but now surfaces a transient notice naming the `y`/`a`/`n` answer path instead of failing silently.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `tui-ask-approval`: the "prompt captures the decision with focus-gated keys" requirement gains two additional answer paths — mouse activation of the choice options and composer-submitted answer tokens — and the composer's silent busy refusal while an ask is docked becomes a noticed refusal.

## Impact

- `cli/src/tui/components/ask_prompt.tsx` — the choice hint row splits into per-option clickable segments (mouse-up + live-selection guard, `selectable={false}`, inert-gated).
- `cli/src/tui/app.tsx` — `handleSubmit` intercepts answer tokens before the busy gate; a pure `parseAskAnswer` helper; the docked-ask notice.
- `cli/src/tui/layout/design_gallery.tsx` — choice-mode ask exhibits become `inert` so gallery clicks cannot flip exhibit state or steal focus.
- Tests: `ask_prompt.render.test.tsx` (mouse activation + drag guard), pure-derivation submit-precedence coverage (`parseAskAnswer` + `askSubmitAction`), gallery render test if exhibit props change.
- No new dependencies; no schema, storage, or harness changes — the gateway funnel (`answerAsk`) is reused as-is.
