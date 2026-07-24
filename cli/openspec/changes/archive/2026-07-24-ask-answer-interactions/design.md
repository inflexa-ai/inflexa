## Context

The docked ask prompt (`src/tui/components/ask_prompt.tsx`) captures approval decisions through ONE key layer gated on the prompt box's focus target — the gate that makes bare `y`/`a`/`n` legal (`ask_prompt.tsx:110-125`). Its choice hints render as inline spans inside a single `<text>`, so no option is a mouse target. The composer path is blocked upstream: while a turn is busy, `handleSubmit` returns before doing anything (`app.tsx:704`), and an ask only pends inside a busy turn. Focus choreography already handles every post-answer transition: `settleAsk` advances the queue, the head-identity effect focuses the next prompt, and a drain refocuses via `askDrainRefocusTarget` — the stream pane (NORMAL) while the turn still runs, the composer once it ended (`app.tsx:550-566`, `app.tsx:273`).

Established idioms this change composes (no new machinery):

- Clickable option boxes on mouse-up: `confirm_dialog.tsx:78-89`.
- In-chat clickable text with `selectable={false}` ("buttons, not prose") and the live-selection drag guard read off `renderer.getSelection()?.getSelectedText()`: `run_block.tsx:215-289`, `app.tsx:406-419`.
- The single gateway funnel `answerAsk(askId, reply)` with `answerBusy` double-answer protection and stale-outcome handling: `app.tsx:491-538`.
- Pure exported app helpers pinned by unit tests: `askDrainRefocusTarget`, `interruptHintFor` (`app.tsx:245-275`).
- Transient notices via `notify({ kind, text })`.

## Goals / Non-Goals

**Goals:**

- A click on a choice option answers the head ask exactly as its key would — including `n` entering feedback mode.
- The composer answers the head ask when the submitted buffer is exactly `y`, `a`, or `n` (trimmed, case-insensitive), clearing the buffer and leaving all focus/mode transitions to the existing choreography.
- A non-answer submit while an ask is docked is refused with a transient notice naming the answer path; the draft is preserved.
- Gallery exhibits stay fully inert under mouse.

**Non-Goals:**

- Composer-carried reject feedback (`n <text>` → reject with feedback). Deliberately excluded: a mistyped real message would silently become a rejection with feedback. Tracked as a follow-up GitHub issue; the prompt's feedback mode remains the only feedback path.
- Clickable hints in feedback mode (`enter submit · esc back`). The feedback input already owns that surface; scope stays on the choice options.
- Answer synonyms (`yes`, `no`, `always`). The tokens mirror the rendered key hints one-for-one.
- Any change to the harness gateway, the ask ledger, or the pending-asks store.

## Decisions

**D1 — Activate options on mouse-UP with the live-selection guard, never on mouse-down.** Mouse-down fires the instant a user starts a text-selection drag over the hint row; an accidental "approve command execution" from a drag start is the worst possible failure here. Mouse-up alone is not enough either — a drag that *ends* on an option fires its mouse-up (the documented sidebar hazard, `app.tsx:406-411`) — so each activation first reads the live selection and bails when text is selected, the exact idiom of `releaseMarker` (`run_block.tsx:231-234`) and `openRunsFromSidebar`. Live-selection read over remembered press state for the reason documented at `run_block.tsx:226-230`: a flag can outlive its gesture.

**D2 — Each option is its own `<text selectable={false}>` segment in a row box; separators stay muted plain text.** opentui mouse handlers attach to renderables, not inline spans, so the single hint `<text>` must split. `selectable={false}` because options are buttons, not prose (`run_block.tsx:254-257`). The AskPrompt keeps its pure props+callbacks contract except for one addition: `useRenderer()` for the selection guard — the same dependency `run_block.tsx` (also in `components/`) already takes for the same reason.

**D3 — Clicks route through the SAME handlers as the keys** (`approve("once" | "always")`, `enterFeedback()`), inheriting the `busy` gate for free. A click on `n` enters feedback mode exactly like the key — no click-specific shortcut to bare reject, so the two input methods cannot drift.

**D4 — Gallery exhibits gate clicks on `props.inert`.** Without this, clicking "n reject" on a gallery exhibit flips it into feedback mode and its auto-focusing input steals the gallery pane's focus. The click handlers no-op when `inert` is set, and the gallery's choice-mode exhibits (which today rely only on the focus gate for inertness) pass `inert`. Alternative rejected: leaving gallery clicks live with no-op callbacks — the local `setMode("feedback")` still fires, so the exhibit mutates.

**D5 — Composer interception lives in `handleSubmit` after the `/quit` branch, before the busy gate, keyed on `activeAsk()` — not on `chatStatus()`.** The ask queue is the source of truth for "an answer is expected"; busy is merely correlated. A pure exported `parseAskAnswer(text: string): AskReply | null` beside the other pure helpers keeps the token mapping unit-testable without mounting the app. Mapping: `y` → `{ kind: "once" }`, `a` → `{ kind: "always" }`, `n` → `{ kind: "reject" }` after trim + lowercase; everything else → `null`. The decision precedence is itself a second pure helper, `askSubmitAction(text, askDocked, answerBusy)`, returning a discriminated action (`passthrough | swallow | answer | refuse`) that `handleSubmit` merely executes — no test can mount the full App (runtime/DB/providers), so the whole precedence table is pinned at the same pure-derivation altitude `interrupt_hint.test.ts` established.

**D6 — On a parsed answer: clear the buffer, call `answerAsk`, return — and change nothing about focus.** The settle path already runs the head-identity/drain effect, which restores NORMAL (pane) while the turn is busy or advances focus to the next prompt. Duplicating a focus move at submit time would race the drain effect and re-create the double-focus-owner bug class the identity gate exists to prevent (`app.tsx:540-549`). While `answerBusy()` is true a repeated submit is swallowed (no notice): the first answer is in flight and the prompt already renders its busy state.

**D7 — Non-answer text while an ask is docked: keep the refusal (return before clearing — the draft survives), add `notify({ kind: "info", text: "An approval is pending — answer y, a, or n (or use the prompt above)." })`.** Silent refusal is the discoverability hole this change exists to close; turning the submit into a rejection-with-feedback is the rejected dangerous alternative (see Non-Goals).

## Risks / Trade-offs

- [A drag-release lands on an option with an empty selection (zero-length drag) and activates it] → That gesture is indistinguishable from a click by design; the guard only suppresses releases that carry a real selection, matching every existing clickable surface.
- [Case-insensitive `Y` answers while the hints advertise lowercase `y`] → Accepted: trim+lowercase costs nothing and matches user intent; the hints stay lowercase per the keymap label rule.
- [A user typing a genuine one-letter message (`y` as "yes" to the *model*) answers the ask instead] → Accepted and intended: while an ask is docked the turn is suspended waiting on exactly this decision — no message can reach the model until it settles anyway.
- [The composer notice fires on every non-answer submit, potentially repetitive] → The notice slot is single and auto-dismissed; repeated submits just refresh it.
- [`useRenderer()` in AskPrompt widens its dependency surface] → Matches `run_block.tsx` precedent; the component stays host-agnostic (no store/gateway imports).

## Open Questions

None — token set, bare-`n` semantics, and the notice were decided with the user; composer reject feedback is tracked as a follow-up issue rather than left open here.
