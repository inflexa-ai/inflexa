## Context

The harness half of the approval feature is complete and archived on this
branch: `ctx.ask` suspends a tool on a poll-backed `cortex_asks` row,
`createAskGateway({pool})` carries `ask/answer/pending/sweepExpired`, the
`data-ask` part (registry: conversation-emitted, reconciling) is emitted by the
gateway through the turn's `emit`, and a rejected ask hard-stops the turn
(`finish.reason: "denied"`). The CLI currently consumes the local harness via
symlink (`bun run harness:local`), so all of that is resolvable today.

CLI ground truth this design builds on (verified):
- Composition root: seam realizations are built inside `bootHarnessRuntimeOnce`
  (`runtime.ts:679-894`, the `UnavailablePreviewPublisher` site at `:894`);
  boot one-shot chores live in `beforeLaunch` (`runtime.ts:928-940`), which
  `bootHarness` runs AFTER `initCortexState` — so the ask tables exist when the
  sweep fires. `HarnessRuntime` (`runtime.ts:157-194`) is reachable from the
  TUI via `harnessRuntime()` (`tui/hooks/boot.ts:45`).
- Turn engine: `runAgent` opts are exactly
  `{ provider: chat, signal, emit, runStep: passthroughStep }` (`turn.ts:170`);
  `RunChatTurnArgs` already carries `analysisId/threadId/signal/emit`. Callers:
  TUI `conversation.ts:906-918` (guarded `emitForTurn`, `myTurn.signal`,
  `threadId == sessionId`) and REPL `chat.ts:277-288`.
- Parts: unknown `data-*` becomes a `[part:…]` mention in both surfaces
  (`conversation.ts:346-357`, `chat_printer.ts:297-300`). Store parts are
  copy-on-receive, primitive-only. Data parts are NOT persisted; reload rebuilds
  cards from tool_use rows in the harness card resolver, which has no
  `data-ask` branch.
- TUI shell: the docking column is `app.tsx:435` (Chat scrollbox →
  boot-indicator `<Show>` → `ChatBar`); fixed chrome below a `flexGrow`
  scrollbox must be a full-width `flexShrink={0}` box painted with a background
  (the 1-cell bleed rule). The composer textarea keeps focus during a turn;
  submit is refused while `chatStatus() === "busy"` (`app.tsx:375`). Keymap:
  bindings are data via `useBindings`; a layer coexisting with a focused editor
  MUST NOT bind bare printables unless gated on a focus `target`
  (`keymap.ts:394-401`); the focus-target pattern is `app.tsx:327-334`.

## Goals / Non-Goals

**Goals:**
- A real `ctx.ask` round-trips through the docked prompt: approve resolves the
  suspended tool, `always` records the standing grant, reject (with optional
  feedback) denies and the turn's denial is visible in the transcript.
- The prompt shows the exact action being approved; pending asks stack and are
  answered one by one; the composer is gated while an ask is pending.
- Every new visual state is a gallery exhibit; proof is headless (render +
  store + reader tests) — no model credits.

**Non-Goals:**
- No harness changes of any kind (the primitive is closed and archived).
- No REPL interactive prompt — the REPL is a write-only sink with no mid-turn
  input path; it stays deny-by-default (`UnavailableAsk` via omitted `ask`).
- No transcript-reload reconstruction of asks (needs the harness card resolver;
  the ledger is the durable record). Asks are live-turn-only visuals.
- No consumer tool (#154) and no `pending()`-driven hydration at boot — chat is
  single-process, so boot-time pending rows are crash orphans the sweep expires.

## Decisions

### D1 — Gateway realized at the composition root, exposed on HarnessRuntime

`createAskGateway({ pool })` is constructed in `bootHarnessRuntimeOnce`
alongside the other seam realizations and surfaced as a new
`HarnessRuntime.askGateway` field. `beforeLaunch` gains
`await gateway.sweepExpired()` next to the existing sweep-style chores —
ordering is safe because `bootHarness` runs `initCortexState` first. The TUI
answers through `harnessRuntime().askGateway.answer(...)`. Alternative
rejected: constructing the gateway ad hoc in the TUI from `runtime.pool` —
that scatters seam realization away from the composition root.

### D2 — Per-turn binding rides RunChatTurnArgs as a pre-bound function

`RunChatTurnArgs` gains optional
`ask?: (request: AskRequest) => Promise<AskApproval>`; `runChatTurn` spreads it
into the `runAgent` options when present. The **caller** binds the gateway:
the TUI passes `(req) => gateway.ask(req, { analysisId, threadId: sessionId,
signal: myTurn.signal, emit: emitForTurn })` so the gateway's `data-ask`
emissions ride the same guarded sink and abort signal as every other turn
event. The REPL passes nothing → the harness's deny-by-default. The engine
stays decoupled from the gateway type (it only knows the function shape),
mirroring how `emit` is caller-owned.

### D3 — data-ask handling: shared reader, lean card part, reconcile-by-id

`readAskPart(data)` lives in `chat_printer.ts` beside `readRunCard` (same
defensive narrow; `status` validated against
`pending | resolved | rejected | aborted | expired`, unrecognized → `expired`
as the safe terminal). The TUI Part union gains `AskCardPart`
`{ id; type: "ask-card"; askId; title; command; detail?; status }` (lean
card shape, copy-on-receive). Because the part is **reconciling** (same
`askId`, pending → terminal), `renderDataPart`'s `data-ask` case must
update-in-place: if the current assistant turn already holds an `ask-card`
with that `askId`, overwrite its `status`; else append. The same case drives
the pending-asks store (below). The REPL printer gains a `case "data-ask"`
one-liner (`approval: <command> — <status>`), replacing the raw
`[part:data-ask]` fallthrough.

### D4 — Pending-asks store: a module singleton in the hooks layer

`tui/hooks/asks.ts` follows the `status.ts` pattern: a `createStore`-backed
FIFO of pending asks (`{ askId, title, command, detail? }`), with
`activeAsk()` (head), `pushAsk`, `settleAsk(askId)`, `clearAsks()`. Written
ONLY from `conversation.ts`'s `data-ask` case (pending → push; terminal →
settle) and from turn teardown (`finishTurn`/reset → clear, covering aborts
where a terminal re-emit may never arrive). Read by `app.tsx` and the prompt.
Queue semantics: answers one by one, head-first; the widget shows a
`+N more` hint when the queue is deeper than one.

### D5 — AskPrompt: components/ widget, two modes, focus-steal while pending

`tui/components/ask_prompt.tsx` takes primitive props
(`title, command, detail?, queuedCount, busy?`) and callbacks
(`onApprove(kind: "once" | "always")`, `onReject(feedback?: string)`). Two
modes held in local state: **choice** (`y` approve once, `a` approve always,
`n` reject) and **feedback** (entered from `n`: a `TextInput` for optional
reject feedback; `enter` submits — empty string means no feedback — `esc`
returns to choice). Keys are a `useBindings` layer gated on a focus `target`
(the prompt's own focusable renderable), which is the only pattern that makes
bare printables legal; the layer also binds nothing global. When an ask
becomes active, App focuses the prompt (`queueMicrotask` ref focus — the
established pattern); when the queue drains, focus returns to the composer
textarea. Focus-steal doubles as the composer gate: the textarea is blurred
while a decision is pending, and `handleSubmit`'s existing `busy` guard
already refuses submits (an ask only pends inside a busy turn). Esc in choice
mode is a no-op (deciding is the only way forward; ctrl+c still aborts the
whole turn through the existing three-way chord).

### D6 — Docking site and chrome rules

The prompt docks in the chat column between the boot-indicator `<Show>` and
`<ChatBar>` (`app.tsx:451-456`): a full-width `flexShrink={0}` box painted
with the panel background (the scrollbox-bleed rule — it can sit directly
below the Chat scrollbox). Rendered under `<Show when={activeAsk()}>`.
Styling via `theme` roles, `GLYPHS`, and the emphasis components — no inline
hex, no glyph literals.

### D7 — Answer path and outcome handling

Callbacks call `askGateway.answer(askId, reply)` (fire from the prompt's
handler; `busy` prop true while in flight). `applied` → `settleAsk` advances
the queue (the gateway's terminal re-emit also reconciles the transcript
card). `not_found` / `already_terminal` → surface a notice via the existing
toast (`notify`) and settle the entry anyway — the ledger has moved on and
holding the prompt open would wedge the queue. The reply type keeps all three
variants even though the surface renders approve/always/reject as its three
actions.

### D8 — Live-turn-only visuals

No reload path: after reopen, past asks do not re-render (no `data-ask`
branch exists in the harness card resolver, and adding one is out of scope).
The `cortex_asks` ledger remains the durable audit. Turn teardown clears the
pending store so an abort can never leave a stale docked prompt.

## Risks / Trade-offs

- **Focus choreography** (INSERT/NORMAL assumes focus on textarea or scroll
  pane) → the prompt is a third focus holder only while visible; App's
  focus moves are explicit (on ask-active → prompt, on drain → textarea), and
  the render tests cover the transitions.
- **Reconcile-by-id is new for the append-only parts store** → confined to the
  `data-ask` case (find-by-askId in the current turn's parts, overwrite
  status); everything else stays append-only.
- **A terminal re-emit may never arrive on abort** → turn teardown clears the
  store (D4); the transcript card's last status then honestly reads `pending`
  until reload drops it (D8) — acceptable for live-turn-only visuals.
- **`<For>` reuse-path fragility in opentui** (the shrink-then-grow silent-drop
  lesson) → the docked surface renders only the head ask via `<Show>` (+ a
  count), never a `<For>` list.
- **CI typecheck at the registry pin cannot see the primitive** → expected and
  accepted; correctness is against the local link, releases are handled by the
  maintainer.

## Migration Plan

Additive UI wiring; no data migration. Ships dark until a tool calls
`ctx.ask` (#154) — until then the gallery exhibit and tests are the proof.
Rollback = revert the CLI change; the harness primitive is untouched.

## Open Questions

None blocking. Key-cap choice (`y/a/n`) and the `+N more` hint copy are
gallery-reviewable details.
