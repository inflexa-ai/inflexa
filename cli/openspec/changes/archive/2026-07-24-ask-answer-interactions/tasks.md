## 1. Clickable choice options (ask_prompt.tsx)

- [x] 1.1 Split the choice hint row into per-option clickable `<text selectable={false}>` segments (y approve / a always / n reject) inside the existing row box, keeping the middot separators as muted plain text and the queued-count hint unchanged; route clicks through the SAME handlers as the keys (`approve("once")`, `approve("always")`, `enterFeedback()`)
- [x] 1.2 Guard activation: mouse-up only, bail when `useRenderer()`'s live selection carries text (the `releaseMarker` idiom), and no-op entirely when `props.inert` is set; document the why (drag-release hazard, gallery inertness) per the design's D1/D4
- [x] 1.3 Pass `inert` on the design gallery's choice-mode ask exhibits so exhibit clicks cannot flip mode or steal focus

## 2. Composer answer path (app.tsx)

- [x] 2.1 Add pure exported `parseAskAnswer(text: string): AskReply | null` beside the other pure helpers (trim + lowercase; `y` → once, `a` → always, `n` → reject with no feedback; else null) with JSDoc
- [x] 2.2 Intercept in `handleSubmit` after the `/quit` branch and before the `chatStatus() === "busy"` gate, keyed on `activeAsk()`: parsed token → clear buffer, `answerAsk(head.askId, reply)`, return (no focus moves — the drain choreography owns transitions); while `answerBusy()` swallow the submit silently
- [x] 2.3 Non-answer text while an ask is docked: keep the refusal (return BEFORE clearing so the draft survives) and `notify` the transient info notice naming the y/a/n answer path

## 3. Tests

- [x] 3.1 `ask_prompt.render.test.tsx`: mouse click on each option activates its handler (mockMouse.click at the option's frame coordinates); a selection drag released over an option does not activate; clicks are inert under `busy` and under `inert`
- [x] 3.2 Unit-test `parseAskAnswer` (tokens, trim, case, rejects everything else) alongside the existing pure-helper tests
- [x] 3.3 Pure-derivation submit-precedence coverage for the composer path (`parseAskAnswer` + `askSubmitAction`): submit `y` with a docked ask answers approve-once and clears the buffer; submit non-answer text keeps the draft and surfaces the notice; submit `y` with no docked ask sends a normal message
- [x] 3.4 Run `bun run typecheck`, `bun run lint`, and the full `bun test` suite in `cli/`; `bun run format:file` on every touched `src/` file

## 4. Follow-up tracking

- [x] 4.1 Open a GitHub issue for the deliberately-excluded composer reject-feedback path (`n <text>` → reject with feedback), linking this change and the design's Non-Goals rationale
