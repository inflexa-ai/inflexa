# Design — chat-interrupt-persist-flow

## D1. The aborted turn resolves; the engine branches on the finish reason

With the harness change in place, an interrupted chat turn RESOLVES from `runAgent` with `finish.reason === "aborted"` and the partial transcript — it no longer throws. `runChatTurn`'s success arm therefore branches on the finish reason: `"aborted"` produces the `aborted` outcome with `toPersist = [userMessage, ...result.messages.slice(initial.length)]` (identical in shape to the ok path; an empty partial degenerates to `[userMessage]`, preserving the retract window's no-output persistence exactly). The catch-arm's AbortError classification stays as written — it is now the defensive path for aborts that never reached the streaming wrapper (e.g. prepare raced the signal), not the primary route. `TurnOutcome` keeps its shape; `aborted` gains no `fallbackText` because both surfaces stream deltas live and the partial is already on screen.

## D2. One badge vocabulary, two sources

The live turn keeps setting the UI `interrupted` flag directly at abort time — no behavior change while the app runs. On reload, `cortexToUiMessage` maps the harness `CortexMessage.interrupted` field onto the same UI flag, so the reloaded transcript renders exactly what the live view showed: partial text with the muted marker, or (for a no-output abort) no assistant bubble at all — which now matches the durable state by construction, since a no-output abort persists no assistant row.

## D3. Focus follows the turn: two automatic transitions, and only two

Entering INSERT is a deliberate act; the app changes mode for the user in exactly two places:

- **An accepted submit focuses the stream pane.** Only the path that reaches `conversation.send` moves focus — the busy/booting/no-analysis refusals return before it and keep both focus and the typed text, so a refused submit never strands the user in NORMAL over a full composer. Rationale: while a turn runs, the composer cannot submit anyway, and every mid-turn affordance (esc-esc interrupt, up-arrow retract, scroll keys) lives on the pane. This is what dissolves the three-press interrupt without touching the arming rule — and the hint (gated busy ∧ NORMAL) becomes visible at exactly the moment it turns true.
- **A completed retract focuses the composer.** The seed callback already writes the text and moves the cursor to the end; focusing the textarea is the missing third step. A retract that downgrades (output raced in) or declines the seed (user typed meanwhile) does not move focus.

Turn completion moves focus nowhere: auto-refocusing INSERT on an async event would steal focus mid-scroll and turn the next `j`/`k` into inserted text. `i`/enter remain the way back.

## D4. The ask-drain refocus is busy-aware

The dock effect's drain branch currently refocuses the composer unconditionally. Asks resolve mid-turn, so that would drop the user into INSERT while the turn still runs — hiding the interrupt hint and resurrecting the three-press case. The drain target becomes: the pane while `chatStatus() === "busy"`, the composer otherwise (a rejection that ends the turn lands the user ready to type, which the existing reject scenario already promises).

## D5. The retract layer gains the pane target, bounded by the window

After an accepted submit the user sits on the pane, so `up` must retract from there. A second retract layer targets the pane, enabled by the same `canRetract()` gate, at a priority above the pane's scroll layer — so during the no-output window `up` means retract, and the moment the gate closes (first delta, turn end) it reverts to scroll-up. Accepted cost, stated deliberately: for the seconds before the first token, `up` does not scroll; `k`, `ctrl+u`, and the page keys scroll throughout, and there is no new output to scroll to during that window. The existing textarea-targeted layer stays, so `i`-then-`up` retracts too; both run the same retract with the same seed-and-focus completion.

## D6. The hint lives beside the mode word it describes

The interrupt hint is a promise about what esc does *given the current mode* — it belongs next to the mode word, not in the top-right status bar where the eyes never rest mid-turn. The ChatBar footer gains a hint slot after the mode word:

- **NORMAL + busy**: the esc hint (`esc interrupt` → `esc again to interrupt` while armed), derived from the live `app.interrupt` binding as today. Armed state needs a treatment distinct from the NORMAL word's accent (the footer row is `bgActive` with an accent mode word); the design-gallery exhibit fixes the exact styling, checked on `github-light`.
- **INSERT + busy**: the abort-chord hint (derived from `app.abort`, ctrl+c by default) — the one-press interrupt that already works while typing, currently unadvertised.
- Idle, dialog stacked, ask docked: no hint, same honesty gates as today.

The `interruptHintFor` derivation stays a pure exported function (extended to produce the INSERT variant); the status bar's `interruptHint` prop and its render branch are removed rather than duplicated — one render site. The footer's "no global keybind hints" rule survives with a sharper boundary: palette/sidebar/quit hints stay status-bar-only; the footer carries only mode-scoped affordances — the mode word and what the interrupt keys mean in that mode.

## D7. What deliberately does not change

- The arming semantics, 5-second window, NORMAL-only counting, and every exclusion (dialog, selection, INSERT esc) — untouched.
- `canRetract()`'s zero-output gate, the generation-token ordering, the heal machinery — untouched.
- The ctrl+c three-way chord ordering — untouched; it merely becomes advertised in INSERT.
- The no-output abort still persists `[userMessage]` alone; the retract flow's durable behavior is byte-identical.
