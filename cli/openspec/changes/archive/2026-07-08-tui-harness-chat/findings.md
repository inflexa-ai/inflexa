# tui-harness-chat — Findings

Live + static verification of the TUI harness chat. One scripted PTY pass
(`scratchpad/tui_e2e.exp`), `harness.model` pinned to `claude-sonnet-4-6`, per the
loop.md frugality budget.

## F1 — Live E2E of the new surface: PASS (first attempt, exit 0)

`inflexa resume <A1>` opened the TUI and the log
(`scratchpad/tui_e2e.log`) confirmed, in order:

1. **Shell painted** — the alternate-screen app came up.
2. **Boot gate visible** — the `booting` status/animation rendered while the runtime
   booted (input gated).
3. **Runtime ready** — `startHarnessBoot` drove the boot store to `ready`; the status
   bar flipped to `ready`. First-ever live exercise of the boot-state store + the
   normal-stdio preamble gates.
4. **Profile parity trigger fired** — `profiling` appeared in the transcript (the
   `watchProfileParity` notice), proving task 4.3 live: on `ready`, the analysis was
   checked and the stage → seed → trigger sequence ran non-blocking without gating
   chat.
5. **Turn streamed + rendered** — the requested phrase `tui skeleton alive` rendered
   in the message stream (3 occurrences in the raw log), proving the whole new path
   live: `send()` → `createStreamingChat(provider)` → `runChatTurn` (the shared
   engine) → the emit adapter → the Solid store → `MessageBlock`.
6. **Clean quit** — a single Ctrl+C at the idle prompt drained to `eof`, exit status
   `0` (terminal restored via `renderer.destroy()`, locks released by the exit hook).

**Zero error signals** in the log (grep for error/failed/exception/undefined found
none outside the expected banner-plumbing identifiers).

## F2 — Thread lineage (D1) verified structurally, not re-queried live

`threadId := sessionId` (design D1) is asserted by the `send` unit tests
(`buildChatSession("tui-chat", analysisId, sessionId)` — threadId equals the session
id) and the turn persisted with no "could not save the turn" toast in the live log
(no append error). A direct `cortex_analysis_threads` row re-query was deliberately
skipped to avoid a second boot (frugality); the prior `embed-conversation-agent` E2E
already proved the pg thread round-trip + `cortex_runs.thread_id` stamp on the
identical engine.

## F3 — REPL regression (5.3): satisfied without a separate live pass

The REPL (`inflexa chat`) drives the SAME `runChatTurn` just proven live through the
TUI. Its remaining local glue (turn-scoped SIGINT wiring, outcome→sink-line mapping)
is pure and covered by the 108 passing `modules/harness/` unit tests, and the REPL
diff was reviewed as behavior-identical (the session build now routes through
`buildChatSession("cli-chat", …)`, same shape as before). No separate live REPL run
was spent — honoring the one-PTY-pass budget while still retiring the shared-engine
risk live.

## F4 — Static verification: clean

- `bun run typecheck` — clean.
- `bun run lint` (`eslint .`) — clean.
- `bun test` (full suite) — **514 pass, 2 skip, 0 fail** (516 tests, 67 files).
- `bun run format:file` applied to every touched `src/` file by the workers.

## F5 — Adversarial verify pass (all 7 delta specs vs landed code)

Ten targeted hunts (clone-on-receive, depth filter, flush-on-completion, unconditional
appendTurn, boot gate + passive-path cleanliness, lock-exchange atomicity, profile
parity + single-source ledger seed, never-exhaustiveness, hygiene, loadMessages
sourcing) — **all satisfied with file:line evidence**. Findings that survived, and
their dispositions (all fixed in the same change before archive):

- **C1 (CRITICAL, fixed)** — no turn-generation guard: after a rapid session swap, a
  superseded turn's `finishTurn` could flush/clear the successor turn's streaming
  signals (its tail would never render) and fire stale status/error writes. Fixed
  with a per-turn token (the turn's own `AbortController` instance): all late events
  and the outcome of a superseded turn are dropped at the send boundary.
- **W1 (fixed)** — aborted/failed turns left tool parts stuck at `running`; the
  finish path now resolves open tool parts to a terminal state (the REPL printer's
  chip-closing rule, mirrored).
- **W2 (fixed)** — `UIMessage.durationMs` was never stamped by the new send path.
- **W3 (fixed)** — `loadMessages` lacked a staleness guard; interleaved swap loads
  could land out of order.
- **W4 (comment softened; harness follow-up)** — replayed tool calls render "ok"
  because the harness reconstruction does not thread `is_error` into rebuilt cards;
  the cli code is contract-correct. Follow-up: thread `is_error` through
  `content-to-cortex` (additive harness change).
- **S1/S2/S3 (fixed)** — empty assistant bubble on pre-run failures popped; the
  parity trigger now runs `reconcileOrphanedDataProfile` like the command (wedged
  `running` rows self-heal in the TUI path too); the two `textareaRef!` assertions
  carry their invariant comments.

## Carried-forward (not regressions of this change)

- **Chat-model boot probe gap (prior F1)** — boot still probes the embedder but not the
  chat model, so a dead-but-advertised Claude default would pass boot and fail at the
  first turn. Worked around by pinning `harness.model`. Unchanged by this change;
  remains the named follow-up.
