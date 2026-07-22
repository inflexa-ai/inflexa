## 1. Conversation hook

- [x] 1.1 Add the `canRetract()` accessor (busy ∧ empty stream ∧ only the pre-minted assistant part ∧ no open tools) and the `interruptArmed` signal with the `INTERRUPT_ARM_WINDOW_MS = 5000` constant (arm/refresh/expire; cleared when the turn ends)
- [x] 1.2 Retain the in-flight turn's completion promise and the outcome's `appendTurn` fault in `src/tui/hooks/conversation.ts` so the retract can await settlement and decide the durable step
- [x] 1.3 Expose a tail-turn retract from the CLI harness embedder (`src/modules/harness/`) over the same pool/history wiring the turn engine uses, and thread it into the conversation hook's seams
- [x] 1.4 Implement `retract()`: claim the generation token → `abort()` → await settlement → re-validate the gate (on violation: downgrade to plain interrupt + notice) → splice the last user message and assistant placeholder from the store → durable retract (skipped on append fault) → seed the composer with the original text, cursor at end. On a session swap superseding the sequence, drop the remaining store writes and composer seed but complete the durable removal
- [x] 1.5 On a durable-retract `DbError`: error notice, composer stays seeded, and the removal is retained as pending for the thread — retried once before the next send, with a second failure letting the send proceed
- [x] 1.6 Mark the assistant `UIMessage` `interrupted` when an aborted turn streamed output; ensure an aborted no-output turn leaves no empty assistant shell

## 2. Bindings and surfaces

- [x] 2.1 Add `app.interrupt` to `KEYBIND_DEFAULTS` and the arm/fire bindings to the busy-gated scroll-pane (NORMAL) layer in `src/tui/app.tsx`, disabled while a dialog is stacked or a text selection is active
- [x] 2.2 Add the textarea-targeted up-arrow retract layer, enabled only on empty buffer ∧ `canRetract()`
- [x] 2.3 Pass the interrupt hint (label from `chordLabel(app.interrupt)`, armed flip, accent treatment) into `StatusBar` as data from `app.tsx`; render it in the right hints region only while busy
- [x] 2.4 Render the muted "interrupted" marker in the message block; add design-gallery exhibits for the marker and both hint states; verify on `github-light`

## 3. Tests and verification

- [x] 3.1 Conversation-hook unit tests: gate derivation edges (delta, tool part, card part close it), retract ordering under the generation token (in-flight load drops; swap mid-retract drops UI writes while the durable removal completes), racing-delta downgrade, append-fault skip, durable-fault pending-retry at next send
- [x] 3.2 Render tests: hint flip and marker with span-color assertions (not just char frames)
- [x] 3.3 TUI e2e: not writable in this repo today — no TUI e2e harness exists (no PTY/tmux-driving infra; all TUI verification is headless testRender), so double-esc interrupt and the retract round-trip are covered at the hook layer (`conversation.interrupt_retract.test.ts`); add the tmux capture-pane e2e pass when a TUI e2e harness lands
- [x] 3.4 `bun run typecheck`, `bun run lint`, `bun run format:file` on touched files

## 4. Harness dependency

- [x] 4.1 Link the harness build carrying `retractLastTurn` via `bun run harness:local` and re-run the CLI typecheck against it before starting §1
