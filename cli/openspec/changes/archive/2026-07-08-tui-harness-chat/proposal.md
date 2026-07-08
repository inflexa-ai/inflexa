# tui-harness-chat — Proposal

## Why

The TUI chat still talks to the placeholder proxy engine (`modules/intelligence/chat.ts` — a generic
"coding assistant" with no tools, no analysis context, no plans), while the real product loop —
converse → plan → approve → execute → inspect, at parity with Cortex managed — exists only behind the
temporary `inflexa chat` REPL. Per the binding direction (`docs/harness_integration_followup/
14-tui-chat-direction.md`, user decision 2026-07-08): one chat, the harness conversation agent, shipping
in the TUI now — no daemon prerequisite.

## What Changes

- **The TUI send path swaps engines**: `conversation.send` drives the harness turn loop
  (`prepareChatTurn → runAgent(streaming) → appendTurn`) instead of the proxy `chat()`. The proxy engine
  loses its last TUI caller (deletion is change 3, not here; `inflexa sessions` untouched).
- **A headless turn engine is extracted** from the REPL's `runTurn` (`modules/harness/chat.ts`) and
  consumed by BOTH the REPL (behavior unchanged) and the TUI — one turn loop, two surfaces. The
  printer's event-classification logic (sub-agent depth filter, plan/run-card readers, copy-on-receive)
  is shared, not duplicated.
- **Opening an analysis chat boots the embedded runtime** (a deliberate action, per the user decision):
  interactive gates (harness config, sandbox image) run in the normal-stdio phase before the alternate
  screen; the runtime boot runs async behind a boot animation with the chat input gated until ready;
  boot failure renders the actionable boot-error taxonomy. Ctrl+C during boot quits cleanly.
- **Threads bind 1:1 to sessions** (`threadId := sessionId` — `prepareChatTurn` creates absent threads
  under the given id), so the existing session picker/launch/swap machinery keeps working and the
  transcript's source of truth becomes the pg thread (history via `loadPage → contentToCortexMessages`).
  Legacy SQLite transcripts freeze (not rendered); no thread picker.
- **Harness events render in the TUI**: text deltas stream through the existing signal/flush reducer;
  tool activity and `data-plan`/`data-run-card` parts render as real stream blocks (the design system's
  tool/run block states get live data); unknown parts get a tagged mention; sub-agent traffic is dropped;
  everything crossing into the Solid store is cloned (in-process emit shares mutable references).
- **The data profile auto-triggers at parity**: on boot-ready (and analysis swap), if the analysis has
  inputs and no completed profile, the stage → seed → trigger sequence runs non-blocking; chat is NOT
  gated on the profile (verified: the managed chat route has no profile gate).

## Capabilities

### New Capabilities
- `tui-harness-chat`: the TUI's embedded harness chat lifecycle — boot-on-open gating (state machine,
  animation, failure surface, quit semantics), the emit adapter contract (harness `contracts/`
  vocabulary, clone-on-receive, depth filter), session↔thread binding, turn abort semantics, and the
  parity profile auto-trigger.

### Modified Capabilities
- `chat-view`: the conversation store's engine contract changes — `send` drives the shared turn engine
  (not `chat()`), streaming flushes on turn finish (not `session.status` idle), the transcript loads
  from the pg thread (not SQLite messages), and the reducer consumes harness events via the adapter.
- `chat-wiring`: the launcher preamble gains the harness pre-flight gates (normal-stdio phase) and the
  post-render boot kickoff; in-place session/analysis swaps rebind the thread scope, abort in-flight
  turns, and (analysis swap) exchange the per-analysis lock and re-run the profile check.
- `chat-command`: the clearing contract retargets — the replacement is the TUI chat (this change), not
  #33 M3/M4; the REPL becomes a dev/E2E surface (gating is change 3) and SHALL drive the same shared
  turn engine as the TUI.
- `data-profile-launch`: opening an analysis chat in the TUI becomes a second deliberate action that
  stages/boots/triggers (the profile parity trigger); passive flows (bare `inflexa` resolving to
  nothing, `--status`, welcome screen) remain side-effect free.
- `intelligence-module`: the TUI no longer imports the proxy engine; the engine remains (with its
  `sessions` command) as a legacy surface pending change 3.
- `tui-stream-blocks`: the part vocabulary the message block renders exhaustively grows with the
  harness-sourced kinds (tool activity with live data, plan card, run card); the tool/run block states
  render real events instead of fixtures.

## Impact

- `cli/src/modules/harness/`: `chat.ts` (extraction; REPL keeps its shell), new shared turn-engine
  module, `chat_printer.ts` (classification helpers exported/shared).
- `cli/src/tui/`: `hooks/conversation.ts` (engine swap + adapter), `hooks/status.ts` or a boot store
  (boot states), `app.tsx` (gate + status), `layout/chat_bar.tsx` (gated affordance), new boot-animation
  + card block components entering the design gallery, `app.launch.tsx` (preamble + boot kickoff),
  `contexts/workspace.ts` (analysis-swap rebind).
- `cli/src/cli/index.ts`: untouched command surface (the `chat`/`profile`/`run` demotion is change 3).
- Harness: no source changes expected — everything needed is barrel-exported (verified); any gap found
  during implementation lands as an additive barrel rider only.
- No new dependencies. Live E2E budgeted like changes C/F/embed-conversation-agent (one scripted PTY
  pass, pinned model).
